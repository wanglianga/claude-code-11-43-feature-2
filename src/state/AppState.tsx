import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AnalysisRun,
  BatchRelationsDocument,
  CorrelationImpact,
  CorrelationRun,
  CorrelationTask,
  MappingDocument,
  MappingState,
  ServingCalendarDocument,
  TimeSettingsDocument,
  VersionedDocument,
} from '../types';
import { loadDataset, type Dataset } from '../lib/loadDataset';
import {
  KV_KEYS,
  clearAll,
  deleteCorrelationRun as idbDeleteCorrelationRun,
  deleteCorrelationTask as idbDeleteCorrelationTask,
  deleteRun as idbDeleteRun,
  getAllCorrelationRuns,
  getAllCorrelationTasks,
  getAllRuns,
  getAllSnapshots,
  kvGet,
  kvSet,
  saveCorrelationRun,
  saveCorrelationTask,
  saveRun,
  saveSnapshot,
} from '../lib/db';
import { runEngine } from '../engine/runEngine';
import { RULE_VERSION } from '../engine/rules';
import { executeCorrelationTask } from '../engine/correlation/runCorrelation';
import { previewCorrelationImpact } from '../engine/correlation/impact';
import type { CorrelationInput } from '../engine/correlation/correlate';

export interface MappingConflict {
  localRevision: number;
  remoteRevision: number;
  remoteModifiedAt: string;
}

interface AppStateValue {
  dataset: Dataset | null;
  mappingState: MappingState | null;
  runs: AnalysisRun[];
  loading: boolean;
  loadError: string | null;
  conflict: MappingConflict | null;
  currentRun: AnalysisRun | null;
  refreshCurrentRun: () => void;
  saveMapping: (draft: MappingDocument, baseRevision: number) => Promise<void>;
  reloadMapping: () => Promise<void>;
  createRun: (note?: string) => Promise<AnalysisRun>;
  removeRun: (runId: string) => Promise<void>;
  resetWorkspace: () => Promise<void>;
  dismissConflict: () => void;
  // ---- 时间关联：三份独立维护的资料 ----
  timeSettings: VersionedDocument<TimeSettingsDocument> | null;
  calendar: VersionedDocument<ServingCalendarDocument> | null;
  relations: VersionedDocument<BatchRelationsDocument> | null;
  saveTimeSettings: (doc: TimeSettingsDocument) => Promise<void>;
  saveCalendar: (doc: ServingCalendarDocument) => Promise<void>;
  saveRelations: (doc: BatchRelationsDocument) => Promise<void>;
  previewCorrelation: (
    kind: CorrelationImpact['kind'],
    draft: TimeSettingsDocument | ServingCalendarDocument | BatchRelationsDocument,
  ) => CorrelationImpact;
  // ---- 时间关联：运行与任务 ----
  correlationRuns: CorrelationRun[];
  correlationTasks: CorrelationTask[];
  latestCorrelationRunId: string | null;
  startCorrelationRun: (label?: string) => Promise<string>;
  cancelCorrelationTask: (taskId: string) => Promise<void>;
  rerunCorrelationTask: (taskId: string) => Promise<string>;
  removeCorrelationRun: (runId: string) => Promise<void>;
  removeCorrelationTask: (taskId: string) => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | null>(null);

const CHANNEL_NAME = 'campus-meal-dq-mapping';

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [mappingState, setMappingState] = useState<MappingState | null>(null);
  const [runs, setRuns] = useState<AnalysisRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<MappingConflict | null>(null);
  const [currentRun, setCurrentRun] = useState<AnalysisRun | null>(null);
  const [timeSettings, setTimeSettings] = useState<VersionedDocument<TimeSettingsDocument> | null>(null);
  const [calendar, setCalendar] = useState<VersionedDocument<ServingCalendarDocument> | null>(null);
  const [relations, setRelations] = useState<VersionedDocument<BatchRelationsDocument> | null>(null);
  const [correlationRuns, setCorrelationRuns] = useState<CorrelationRun[]>([]);
  const [correlationTasks, setCorrelationTasks] = useState<CorrelationTask[]>([]);
  const [latestCorrelationRunId, setLatestCorrelationRunId] = useState<string | null>(null);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const mappingStateRef = useRef<MappingState | null>(null);
  mappingStateRef.current = mappingState;
  const timeSettingsRef = useRef<VersionedDocument<TimeSettingsDocument> | null>(null);
  timeSettingsRef.current = timeSettings;
  const calendarRef = useRef<VersionedDocument<ServingCalendarDocument> | null>(null);
  calendarRef.current = calendar;
  const relationsRef = useRef<VersionedDocument<BatchRelationsDocument> | null>(null);
  relationsRef.current = relations;
  const datasetRef = useRef<Dataset | null>(null);
  datasetRef.current = dataset;
  /** 代际号：每次启动新任务递增，旧任务晚完成不得覆盖新范围 */
  const generationRef = useRef(0);
  const cancelRef = useRef<Set<string>>(new Set());

  const refreshCurrentRun = useCallback(() => {
    if (!dataset || !mappingStateRef.current) return;
    setCurrentRun(runEngine(dataset, mappingStateRef.current.doc, { mappingRevision: mappingStateRef.current.revision }));
  }, [dataset]);

  const reloadMapping = useCallback(async () => {
    const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
    if (fresh) {
      setMappingState(fresh);
      setConflict(null);
      if (dataset) setCurrentRun(runEngine(dataset, fresh.doc, { mappingRevision: fresh.revision }));
    }
  }, [dataset]);

  useEffect(() => {
    let mounted = true;
    async function bootstrap() {
      try {
        const ds = await loadDataset();
        if (!mounted) return;
        setDataset(ds);

        // 输入快照：记录本次分析固定引用的文件哈希
        await saveSnapshot({
          id: `input-${ds.metaHashes.manifest.slice(0, 10)}`,
          kind: 'INPUT_SNAPSHOT',
          createdAt: new Date().toISOString(),
          payload: {
            manifestHash: ds.metaHashes.manifest,
            fileHashes: ds.hashes,
            batches: ds.manifest.batches.map((b) => ({
              batchId: b.batchId,
              status: b.status,
              expectedRows: b.expectedRows,
            })),
          },
        });

        let state = await kvGet<MappingState>(KV_KEYS.mappingState);
        if (!state) {
          // 首次进入：以随项目提供的种子映射初始化
          state = {
            doc: ds.seedMapping,
            revision: 1,
            lastModifiedAt: ds.seedMapping.updatedAt,
          };
          await kvSet(KV_KEYS.mappingState, state);
        }

        // 三份独立维护的资料：时间设置 / 供餐日历 / 批次关系，各自带修订号
        let tsState = await kvGet<VersionedDocument<TimeSettingsDocument>>(KV_KEYS.timeSettingsState);
        if (!tsState) {
          tsState = { doc: ds.timeSettingsSeed, revision: 1, lastModifiedAt: ds.timeSettingsSeed.updatedAt };
          await kvSet(KV_KEYS.timeSettingsState, tsState);
        }
        let calState = await kvGet<VersionedDocument<ServingCalendarDocument>>(KV_KEYS.calendarState);
        if (!calState) {
          calState = { doc: ds.calendarSeed, revision: 1, lastModifiedAt: ds.calendarSeed.updatedAt };
          await kvSet(KV_KEYS.calendarState, calState);
        }
        let relState = await kvGet<VersionedDocument<BatchRelationsDocument>>(KV_KEYS.relationsState);
        if (!relState) {
          relState = { doc: ds.relationsSeed, revision: 1, lastModifiedAt: ds.relationsSeed.updatedAt };
          await kvSet(KV_KEYS.relationsState, relState);
        }

        // 刷新恢复：上次会话遗留的 RUNNING 任务标记为中断，可重新执行
        const tasks = await getAllCorrelationTasks();
        for (const t of tasks) {
          if (t.status === 'RUNNING') {
            const interrupted: CorrelationTask = {
              ...t,
              status: 'INTERRUPTED',
              finishedAt: new Date().toISOString(),
              error: '页面刷新或关闭导致任务中断，已提交结果不受影响，可重新执行',
            };
            await saveCorrelationTask(interrupted);
          }
        }

        if (!mounted) return;
        setMappingState(state);
        setTimeSettings(tsState);
        setCalendar(calState);
        setRelations(relState);
        setCurrentRun(runEngine(ds, state.doc, { mappingRevision: state.revision }));
        setRuns(await getAllRuns());
        setCorrelationRuns(await getAllCorrelationRuns());
        setCorrelationTasks(await getAllCorrelationTasks());
        setLatestCorrelationRunId((await kvGet<string>(KV_KEYS.latestCorrelationRun)) ?? null);
        await getAllSnapshots(); // 触发索引，快照可在后续页面读取
        setLoading(false);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    bootstrap();

    // 跨标签页：其他标签页保存映射后广播，当前标签页检测版本落后即进入冲突态
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    channel.onmessage = async (ev: MessageEvent<{ type: string; revision: number; modifiedAt: string }>) => {
      if (ev.data?.type !== 'mapping-saved') return;
      const local = mappingStateRef.current;
      if (local && ev.data.revision > local.revision) {
        const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
        if (fresh) {
          setMappingState(fresh);
          setConflict({
            localRevision: local.revision,
            remoteRevision: ev.data.revision,
            remoteModifiedAt: ev.data.modifiedAt,
          });
        }
      }
    };

    return () => {
      mounted = false;
      channel.close();
    };
  }, []);

  const saveMapping = useCallback(
    async (draft: MappingDocument, baseRevision: number) => {
      if (!dataset) throw new Error('数据尚未加载完成');
      // 保存时重新读取 IDB：若另一标签页已提交更高版本，拒绝覆盖并要求重载
      const fresh = await kvGet<MappingState>(KV_KEYS.mappingState);
      if (fresh && fresh.revision !== baseRevision) {
        setMappingState(fresh);
        setConflict({
          localRevision: baseRevision,
          remoteRevision: fresh.revision,
          remoteModifiedAt: fresh.lastModifiedAt,
        });
        throw new MappingSaveConflictError(fresh.revision);
      }
      const now = new Date().toISOString();
      const next: MappingState = {
        doc: { ...draft, ruleVersion: RULE_VERSION, updatedAt: now },
        revision: (fresh?.revision ?? baseRevision) + 1,
        lastModifiedAt: now,
      };
      await kvSet(KV_KEYS.mappingState, next);
      await saveSnapshot({
        id: `mapping-v${next.revision}-${next.doc.mappingVersion}`,
        kind: 'MAPPING_SNAPSHOT',
        createdAt: now,
        payload: next,
      });
      setMappingState(next);
      setCurrentRun(runEngine(dataset, next.doc, { mappingRevision: next.revision }));
      channelRef.current?.postMessage({
        type: 'mapping-saved',
        revision: next.revision,
        modifiedAt: now,
      });
    },
    [dataset],
  );

  const createRun = useCallback(async () => {
    if (!dataset || !mappingStateRef.current) throw new Error('数据尚未加载完成');
    const state = mappingStateRef.current;
    const run = runEngine(dataset, state.doc, { mappingRevision: state.revision });
    await saveRun(run);
    setRuns(await getAllRuns());
    return run;
  }, [dataset]);

  const removeRun = useCallback(async (runId: string) => {
    await idbDeleteRun(runId);
    setRuns(await getAllRuns());
  }, []);

  // ---------- 时间关联：资料保存（各自独立修订，互不改写） ----------

  const saveTimeSettings = useCallback(async (doc: TimeSettingsDocument) => {
    const cur = timeSettingsRef.current;
    const revision = (cur?.revision ?? 1) + 1;
    const next: VersionedDocument<TimeSettingsDocument> = {
      doc: { ...doc, settingsVersion: `ts-v${revision}`, updatedAt: new Date().toISOString() },
      revision,
      lastModifiedAt: new Date().toISOString(),
    };
    await kvSet(KV_KEYS.timeSettingsState, next);
    setTimeSettings(next);
  }, []);

  const saveCalendar = useCallback(async (doc: ServingCalendarDocument) => {
    const cur = calendarRef.current;
    const revision = (cur?.revision ?? 1) + 1;
    const next: VersionedDocument<ServingCalendarDocument> = {
      doc: { ...doc, calendarVersion: `cal-v${revision}`, updatedAt: new Date().toISOString() },
      revision,
      lastModifiedAt: new Date().toISOString(),
    };
    await kvSet(KV_KEYS.calendarState, next);
    setCalendar(next);
  }, []);

  const saveRelations = useCallback(async (doc: BatchRelationsDocument) => {
    const cur = relationsRef.current;
    const revision = (cur?.revision ?? 1) + 1;
    const next: VersionedDocument<BatchRelationsDocument> = {
      doc: { ...doc, relationsVersion: `rel-v${revision}`, updatedAt: new Date().toISOString() },
      revision,
      lastModifiedAt: new Date().toISOString(),
    };
    await kvSet(KV_KEYS.relationsState, next);
    setRelations(next);
  }, []);

  const buildCorrelationInput = useCallback(
    (
      overrides?: {
        timeSettings?: TimeSettingsDocument;
        calendar?: ServingCalendarDocument;
        relations?: BatchRelationsDocument;
        scope?: CorrelationInput['scope'];
      },
    ): CorrelationInput => {
      const ds = datasetRef.current;
      if (!ds) throw new Error('数据尚未加载完成');
      return {
        dataset: ds,
        timeSettings: overrides?.timeSettings ?? timeSettingsRef.current!.doc,
        calendar: overrides?.calendar ?? calendarRef.current!.doc,
        relations: overrides?.relations ?? relationsRef.current!.doc,
        scope: overrides?.scope,
        mappingVersion: mappingStateRef.current?.doc.mappingVersion ?? '',
        mappingRevision: mappingStateRef.current?.revision ?? 0,
        revisions: {
          timeSettings: timeSettingsRef.current!.revision,
          calendar: calendarRef.current!.revision,
          relations: relationsRef.current!.revision,
        },
      };
    },
    [],
  );

  const previewCorrelation = useCallback(
    (
      kind: CorrelationImpact['kind'],
      draft: TimeSettingsDocument | ServingCalendarDocument | BatchRelationsDocument,
    ): CorrelationImpact => {
      const before = buildCorrelationInput();
      const after = buildCorrelationInput(
        kind === 'calendar'
          ? { calendar: draft as ServingCalendarDocument }
          : kind === 'timeSettings'
            ? { timeSettings: draft as TimeSettingsDocument }
            : { relations: draft as BatchRelationsDocument },
      );
      return previewCorrelationImpact(kind, before, after);
    },
    [buildCorrelationInput],
  );

  // ---------- 时间关联：任务生命周期 ----------

  const launchTask = useCallback(
    async (label: string | undefined, scope: CorrelationInput['scope']): Promise<string> => {
      const generation = ++generationRef.current;
      const now = new Date();
      const taskId = `TASK-${stamp(now)}-${generation}`;
      const runId = `CRUN-${stamp(now)}-${generation}`;
      const input = buildCorrelationInput({ scope });
      const task: CorrelationTask = {
        taskId,
        label:
          label ??
          `供餐周期关联（${input.scope ? '指定范围' : '全部学校'} · ${new Date().toLocaleString('zh-CN')}）`,
        scope: input.scope ?? { schoolIds: [], businessDays: [] },
        status: 'RUNNING',
        progress: { done: 0, total: 1, stage: '排队中' },
        createdAt: now.toISOString(),
        generation,
      };
      await saveCorrelationTask(task);
      setCorrelationTasks(await getAllCorrelationTasks());

      void (async () => {
        const run = await executeCorrelationTask({ ...task }, { ...input, runId, taskId }, {
          chunkSize: 25,
          onProgress: (t) => {
            void saveCorrelationTask({ ...t });
            setCorrelationTasks((prev) => prev.map((x) => (x.taskId === t.taskId ? { ...t } : x)));
          },
          shouldCancel: (id) => cancelRef.current.has(id),
          isStale: (t) => t.generation !== generationRef.current,
        });

        if (run && task.generation === generationRef.current) {
          // 正常完成且仍是最新代际：保存不可变运行，更新最新指针
          await saveCorrelationRun(run);
          await kvSet(KV_KEYS.latestCorrelationRun, run.summary.runId);
          const done: CorrelationTask = {
            ...task,
            status: 'DONE',
            resultRunId: run.summary.runId,
            finishedAt: new Date().toISOString(),
            progress: { done: 1, total: 1, stage: '完成' },
          };
          await saveCorrelationTask(done);
          setCorrelationRuns(await getAllCorrelationRuns());
          setLatestCorrelationRunId(run.summary.runId);
        } else {
          // 被取消或被更新任务取代：结果丢弃，不覆盖新范围
          const fresh = (await getAllCorrelationTasks()).find((t) => t.taskId === taskId);
          if (fresh && fresh.status === 'RUNNING') {
            const cancelled: CorrelationTask = {
              ...fresh,
              status: 'CANCELLED',
              finishedAt: new Date().toISOString(),
              error: run === null && task.generation !== generationRef.current ? '已被更新的任务取代' : '已取消',
            };
            await saveCorrelationTask(cancelled);
          }
        }
        setCorrelationTasks(await getAllCorrelationTasks());
      })();
      return taskId;
    },
    [buildCorrelationInput],
  );

  const startCorrelationRun = useCallback(
    (label?: string) => launchTask(label, undefined),
    [launchTask],
  );

  // 首次进入（或重置后）没有任何关联运行与任务时，自动生成一次初始关联运行，
  // 让总览与时间关联页立即可查；之后不再自动重复（刷新页面从 IndexedDB 恢复）
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (loading || autoStartedRef.current) return;
    if (correlationRuns.length === 0 && correlationTasks.length === 0 && dataset) {
      autoStartedRef.current = true;
      void startCorrelationRun('首次自动关联（全量）');
    }
  }, [loading, correlationRuns, correlationTasks, dataset, startCorrelationRun]);

  const cancelCorrelationTask = useCallback(async (taskId: string) => {
    cancelRef.current.add(taskId);
    const tasks = await getAllCorrelationTasks();
    const t = tasks.find((x) => x.taskId === taskId);
    if (t && t.status === 'RUNNING') {
      await saveCorrelationTask({
        ...t,
        status: 'CANCELLED',
        finishedAt: new Date().toISOString(),
        error: '用户取消',
      });
      setCorrelationTasks(await getAllCorrelationTasks());
    }
  }, []);

  const rerunCorrelationTask = useCallback(
    async (taskId: string) => {
      const tasks = await getAllCorrelationTasks();
      const t = tasks.find((x) => x.taskId === taskId);
      return launchTask(t ? `重新执行：${t.label}` : undefined, t?.scope);
    },
    [launchTask],
  );

  const removeCorrelationRun = useCallback(async (runId: string) => {
    await idbDeleteCorrelationRun(runId);
    setCorrelationRuns(await getAllCorrelationRuns());
  }, []);

  const removeCorrelationTask = useCallback(async (taskId: string) => {
    await idbDeleteCorrelationTask(taskId);
    setCorrelationTasks(await getAllCorrelationTasks());
  }, []);

  const resetWorkspace = useCallback(async () => {
    await clearAll();
    autoStartedRef.current = false;
    const ds = await loadDataset();
    setDataset(ds);
    const state: MappingState = {
      doc: ds.seedMapping,
      revision: 1,
      lastModifiedAt: ds.seedMapping.updatedAt,
    };
    await kvSet(KV_KEYS.mappingState, state);
    setMappingState(state);
    const ts = { doc: ds.timeSettingsSeed, revision: 1, lastModifiedAt: ds.timeSettingsSeed.updatedAt };
    const cal = { doc: ds.calendarSeed, revision: 1, lastModifiedAt: ds.calendarSeed.updatedAt };
    const rel = { doc: ds.relationsSeed, revision: 1, lastModifiedAt: ds.relationsSeed.updatedAt };
    await kvSet(KV_KEYS.timeSettingsState, ts);
    await kvSet(KV_KEYS.calendarState, cal);
    await kvSet(KV_KEYS.relationsState, rel);
    setTimeSettings(ts);
    setCalendar(cal);
    setRelations(rel);
    setCurrentRun(runEngine(ds, state.doc, { mappingRevision: state.revision }));
    setRuns([]);
    setCorrelationRuns([]);
    setCorrelationTasks([]);
    setLatestCorrelationRunId(null);
    setConflict(null);
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      dataset,
      mappingState,
      runs,
      loading,
      loadError,
      conflict,
      currentRun,
      refreshCurrentRun,
      saveMapping,
      reloadMapping,
      createRun,
      removeRun,
      resetWorkspace,
      dismissConflict: () => setConflict(null),
      timeSettings,
      calendar,
      relations,
      saveTimeSettings,
      saveCalendar,
      saveRelations,
      previewCorrelation,
      correlationRuns,
      correlationTasks,
      latestCorrelationRunId,
      startCorrelationRun,
      cancelCorrelationTask,
      rerunCorrelationTask,
      removeCorrelationRun,
      removeCorrelationTask,
    }),
    [
      dataset,
      mappingState,
      runs,
      loading,
      loadError,
      conflict,
      currentRun,
      refreshCurrentRun,
      saveMapping,
      reloadMapping,
      createRun,
      removeRun,
      resetWorkspace,
      timeSettings,
      calendar,
      relations,
      saveTimeSettings,
      saveCalendar,
      saveRelations,
      previewCorrelation,
      correlationRuns,
      correlationTasks,
      latestCorrelationRunId,
      startCorrelationRun,
      cancelCorrelationTask,
      rerunCorrelationTask,
      removeCorrelationRun,
      removeCorrelationTask,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export class MappingSaveConflictError extends Error {
  remoteRevision: number;
  constructor(remoteRevision: number) {
    super(`映射版本冲突：检测到更新的修订版本 r${remoteRevision}，请重载后再编辑`);
    this.name = 'MappingSaveConflictError';
    this.remoteRevision = remoteRevision;
  }
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState 必须在 AppStateProvider 内使用');
  return ctx;
}
