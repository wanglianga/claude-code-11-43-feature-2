import { useMemo, useState } from 'react';
import { useAppState } from '../state/AppState';
import { CorrelationBadge, EVENT_TYPE_LABEL, Badge } from '../components/Badges';
import { Drawer, RawRowView } from '../components/Drawer';
import {
  buildCorrelationExport,
  correlationEventsToCsv,
  downloadCsv,
  downloadJson,
} from '../lib/export';
import { diffCorrelationRuns } from '../engine/correlation/impact';
import { correlateRowByRow, correlateSync, type CorrelationInput } from '../engine/correlation/correlate';
import { formatMs, formatRange } from '../engine/correlation/timeNorm';
import { DISPLAY_OFFSET_MINUTES, DISPLAY_TZ_LABEL } from '../lib/display';
import { findRawRow } from '../lib/batchStats';
import type { CorrelatedEvent, CorrelationRun, CorrelationStatus, CorrelationTask } from '../types';

const TASK_STATUS_LABEL: Record<CorrelationTask['status'], string> = {
  RUNNING: '进行中',
  CANCELLED: '已取消',
  DONE: '已完成',
  INTERRUPTED: '已中断',
  FAILED: '失败',
};

export function CorrelationPage() {
  const {
    dataset,
    correlationRuns,
    correlationTasks,
    latestCorrelationRunId,
    startCorrelationRun,
    cancelCorrelationTask,
    rerunCorrelationTask,
    removeCorrelationRun,
    removeCorrelationTask,
  } = useAppState();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [eventKey, setEventKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 3000);
  };

  const selected: CorrelationRun | undefined =
    correlationRuns.find((r) => r.summary.runId === selectedRunId) ??
    correlationRuns.find((r) => r.summary.runId === latestCorrelationRunId) ??
    correlationRuns[0];

  const selectedEvent = selected?.events.find((e) => e.eventKey === eventKey) ?? null;

  return (
    <div>
      <h1 className="page-title">供餐周期时间关联运行</h1>
      <p className="page-desc">
        把领料、制作、发餐等多源事件关联到供餐周期（学校当地日历与业务日）。每次运行固定引用
        时间设置 / 供餐日历 / 批次关系的版本与全部输入哈希；任务分片执行、可取消，刷新页面后已提交结果与未完成任务状态都能恢复。
      </p>

      <div className="filter-bar">
        <button
          className="btn primary"
          onClick={() => void startCorrelationRun().then((id) => flash(`已启动关联任务 ${id}`))}
        >
          新建关联运行（全部学校 · 整批重建）
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          实现路径：统一排序 + 顺序扫描（整批重建）；逐条对照可随时抽查，两条路径结果一致。
        </span>
      </div>

      {correlationTasks.length > 0 && (
        <div className="card">
          <h2>关联任务（处理范围与进度）</h2>
          <table className="data">
            <thead>
              <tr><th>任务</th><th>状态</th><th>进度</th><th>创建时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              {correlationTasks.map((t) => (
                <tr key={t.taskId}>
                  <td>
                    <div>{t.label}</div>
                    <div className="muted mono" style={{ fontSize: 11 }}>{t.taskId}</div>
                    {t.error && <div className="muted" style={{ fontSize: 12 }}>{t.error}</div>}
                  </td>
                  <td>
                    <Badge tone={t.status === 'DONE' ? 'ok' : t.status === 'RUNNING' ? 'candidate' : 'neutral'}>
                      {TASK_STATUS_LABEL[t.status]}
                    </Badge>
                  </td>
                  <td style={{ minWidth: 180 }}>
                    <div className="progress">
                      <div
                        className="progress-inner"
                        style={{ width: `${Math.round((t.progress.done / Math.max(t.progress.total, 1)) * 100)}%` }}
                      />
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {t.progress.stage} · {t.progress.done}/{t.progress.total}
                    </span>
                  </td>
                  <td className="nowrap muted">{new Date(t.createdAt).toLocaleString('zh-CN')}</td>
                  <td>
                    <div className="pill-group">
                      {t.status === 'RUNNING' && (
                        <button className="btn small danger" onClick={() => void cancelCorrelationTask(t.taskId)}>取消</button>
                      )}
                      {(t.status === 'INTERRUPTED' || t.status === 'CANCELLED' || t.status === 'FAILED') && (
                        <button className="btn small" onClick={() => void rerunCorrelationTask(t.taskId).then((id) => flash(`已重新启动 ${id}`))}>重新执行</button>
                      )}
                      {t.resultRunId && (
                        <button className="btn small" onClick={() => setSelectedRunId(t.resultRunId!)}>查看结果</button>
                      )}
                      {t.status !== 'RUNNING' && (
                        <button className="btn small danger" onClick={() => void removeCorrelationTask(t.taskId)}>删除记录</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {correlationRuns.length === 0 ? (
        <div className="card empty">尚无关联运行。点击「新建关联运行」生成第一个；结果保存在浏览器 IndexedDB。</div>
      ) : (
        <div className="card">
          <h2>关联运行（不可变，固定引用当时版本）</h2>
          <table className="data">
            <thead>
              <tr>
                <th>运行编号</th><th>生成时间</th><th>版本固定</th><th>确认/候选/冲突/缺据</th><th className="num">唯一发餐</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {correlationRuns.map((r) => (
                <tr key={r.summary.runId} style={selected?.summary.runId === r.summary.runId ? { background: 'var(--primary-soft)' } : undefined}>
                  <td><b className="mono">{r.summary.runId}</b></td>
                  <td className="nowrap">{new Date(r.summary.createdAt).toLocaleString('zh-CN')}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {r.summary.timeSettingsVersion} · {r.summary.calendarVersion} · {r.summary.relationsVersion}
                    <br />{r.summary.ruleVersion} · 映射 {r.summary.mappingVersion}
                  </td>
                  <td className="nowrap">
                    <CorrelationBadge status="CONFIRMED" /> {r.summary.counts.CONFIRMED}{' '}
                    <CorrelationBadge status="CANDIDATE" /> {r.summary.counts.CANDIDATE}{' '}
                    <CorrelationBadge status="CONFLICT" /> {r.summary.counts.CONFLICT}{' '}
                    <CorrelationBadge status="UNGROUNDED" /> {r.summary.counts.UNGROUNDED}
                  </td>
                  <td className="num">{r.summary.uniqueServings}</td>
                  <td>
                    <div className="pill-group">
                      <button className="btn small" onClick={() => setSelectedRunId(r.summary.runId)}>查看</button>
                      <button className="btn small" onClick={() => downloadJson(`${r.summary.runId}-correlation.json`, buildCorrelationExport(r, new Date().toISOString()))}>导出 JSON</button>
                      <button className="btn small" onClick={() => downloadCsv(`${r.summary.runId}-events.csv`, correlationEventsToCsv(r))}>导出 CSV</button>
                      <button className="btn small danger" onClick={() => void removeCorrelationRun(r.summary.runId)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && dataset && (
        <RunDetail
          run={selected}
          previous={correlationRuns.find((r) => r.summary.createdAt < selected.summary.createdAt && r.summary.runId !== selected.summary.runId)}
          onOpenEvent={(k) => setEventKey(k)}
        />
      )}

      {selectedEvent && (
        <EventDrawer event={selectedEvent} run={selected!} onClose={() => setEventKey(null)} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ---------- 运行详情 ----------

function RunDetail({
  run,
  previous,
  onOpenEvent,
}: {
  run: CorrelationRun;
  previous?: CorrelationRun;
  onOpenEvent: (eventKey: string) => void;
}) {
  const { dataset, timeSettings, calendar, relations } = useAppState();
  const [view, setView] = useState<'period' | 'arrival'>('period');
  const [statusFilter, setStatusFilter] = useState<CorrelationStatus | ''>('');
  const [controlResult, setControlResult] = useState<string | null>(null);

  const diff = useMemo(
    () => (previous ? diffCorrelationRuns(previous, run) : null),
    [previous, run],
  );

  const bySchoolDay = useMemo(() => {
    const g = new Map<string, Map<string, typeof run.periods>>();
    run.periods.forEach((p) => {
      if (!g.has(p.schoolId)) g.set(p.schoolId, new Map());
      const m = g.get(p.schoolId)!;
      if (!m.has(p.businessDay)) m.set(p.businessDay, []);
      m.get(p.businessDay)!.push(p);
    });
    return g;
  }, [run]);

  const arrivalGroups = useMemo(() => {
    const g = new Map<string, CorrelatedEvent[]>();
    run.events.forEach((e) => {
      const day = (e.receivedAt ?? '未知').slice(0, 10);
      if (!g.has(day)) g.set(day, []);
      g.get(day)!.push(e);
    });
    return Array.from(g.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [run]);

  const runControlCheck = () => {
    if (!dataset || !timeSettings || !calendar || !relations) return;
    const input: CorrelationInput = {
      dataset,
      timeSettings: timeSettings.doc,
      calendar: calendar.doc,
      relations: relations.doc,
      runId: 'CONTROL',
      createdAt: run.summary.createdAt,
      revisions: { timeSettings: timeSettings.revision, calendar: calendar.revision, relations: relations.revision },
    };
    const batch = correlateSync(input, 'sweep');
    const control = correlateRowByRow(input);
    const batchMap = new Map(batch.events.map((e) => [e.eventKey, e]));
    let mismatches = 0;
    const samples: string[] = [];
    for (const c of control.events) {
      const b = batchMap.get(c.eventKey);
      if (!b || b.status !== c.status || JSON.stringify(b.periodIds) !== JSON.stringify(c.periodIds)) {
        mismatches += 1;
        if (samples.length < 5) samples.push(c.eventKey);
      }
    }
    const versionNote =
      timeSettings.doc.settingsVersion === run.summary.timeSettingsVersion &&
      calendar.doc.calendarVersion === run.summary.calendarVersion &&
      relations.doc.relationsVersion === run.summary.relationsVersion
        ? '与当前查看的运行使用同一批资料版本'
        : '当前资料版本已与该运行不同，对照针对当前资料重算';
    setControlResult(
      mismatches === 0
        ? `逐条对照通过：${control.events.length} 条事件，排序扫描与逐条计算结果完全一致（含跨日、跨窗口关联）。${versionNote}。`
        : `发现 ${mismatches} 条不一致：${samples.join('、')}（${versionNote}）`,
    );
  };

  const s = run.summary;

  return (
    <>
      <div className="card">
        <h2>运行 {s.runId} 详情</h2>
        <div className="grid cols-4" style={{ marginBottom: 12 }}>
          <div className="stat confirmed"><div className="label">已确认</div><div className="value">{s.counts.CONFIRMED}</div><div className="hint">明确引用 + 时间不矛盾</div></div>
          <div className="stat candidate"><div className="label">仍有候选</div><div className="value">{s.counts.CANDIDATE}</div><div className="hint">不自动进入已确认</div></div>
          <div className="stat unknown"><div className="label">时间冲突</div><div className="value">{s.counts.CONFLICT}</div><div className="hint">引用保留，指出原始行</div></div>
          <div className="stat"><div className="label">缺少依据</div><div className="value">{s.counts.UNGROUNDED}</div><div className="hint">不推断发生或未发生</div></div>
        </div>
        <div className="grid cols-3" style={{ marginBottom: 12 }}>
          <div className="stat"><div className="label">唯一发餐事件</div><div className="value">{s.uniqueServings}</div><div className="hint">同一物理事件多源重复记载只计一次</div></div>
          <div className="stat"><div className="label">重复上报</div><div className="value">{s.duplicateServingReports}</div><div className="hint">真实两次发餐即使时间相同也不合并</div></div>
          <div className="stat"><div className="label">处理范围</div><div className="value" style={{ fontSize: 16 }}>{s.scope.schoolIds.join('、')} 校 · {s.scope.businessDays.length} 个业务日</div><div className="hint">显示时区统一 {DISPLAY_TZ_LABEL}，不改变归属</div></div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          固定引用：时间设置 {s.timeSettingsVersion}(r{s.timeSettingsRevision}) · 日历 {s.calendarVersion}(r{s.calendarRevision}) ·
          批次关系 {s.relationsVersion}(r{s.relationsRevision}) · 规则 {s.ruleVersion} · 映射 {s.mappingVersion}(r{s.mappingRevision}) ·
          输入哈希 {Object.keys(s.inputHashes).length} 个文件。导出的明细与统计均引用本运行编号。
        </p>
        <div className="filter-bar">
          <button className="btn" onClick={() => downloadJson(`${s.runId}-correlation.json`, buildCorrelationExport(run, new Date().toISOString()))}>导出 JSON</button>
          <button className="btn" onClick={() => downloadCsv(`${s.runId}-events.csv`, correlationEventsToCsv(run))}>导出 CSV</button>
          <button className="btn" onClick={runControlCheck}>抽样逐条对照</button>
          <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
            <button className={`tab ${view === 'period' ? 'active' : ''}`} onClick={() => setView('period')}>按供餐周期</button>
            <button className={`tab ${view === 'arrival' ? 'active' : ''}`} onClick={() => setView('arrival')}>按入库日</button>
          </div>
        </div>
        {controlResult && (
          <div className={`banner ${controlResult.includes('通过') ? 'info' : 'error'}`}>{controlResult}</div>
        )}
        {view === 'arrival' && (
          <p className="muted" style={{ fontSize: 12 }}>
            按入库日查看补传规模只是另一种分析视角，不能替换按实际供餐周期得到的关联；历史运行仍使用当时的日历和时间依据。
          </p>
        )}
      </div>

      {diff && diff.changed.length > 0 && (
        <div className="card">
          <h2>与上一运行 {diff.baseRunId} 的差异（更正前后）</h2>
          <table className="data">
            <thead>
              <tr><th>事件</th><th>上一运行</th><th>本运行</th></tr>
            </thead>
            <tbody>
              {diff.changed.map((c) => (
                <tr key={c.eventKey}>
                  <td>{c.label}</td>
                  <td><CorrelationBadge status={c.before.status} /> <span className="mono muted">{c.before.periodIds.join('、') || '（无归属）'}</span></td>
                  <td><CorrelationBadge status={c.after.status} /> <span className="mono muted">{c.after.periodIds.join('、') || '（无归属）'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'period' ? (
        <>
          {Array.from(bySchoolDay.entries()).map(([school, byDay]) => (
            <div className="card" key={school}>
              <h2>{school} 校 · 供餐日浏览</h2>
              {Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([day, periods]) => (
                <div key={day} style={{ marginBottom: 16 }}>
                  <h3>业务日 {day}</h3>
                  {periods.map((p) => {
                    const counts = s.perPeriod.find((x) => x.periodId === p.periodId);
                    const events = run.events.filter((e) => e.periodIds.includes(p.periodId));
                    return (
                      <details key={p.periodId} className="period-block" open={events.length > 0}>
                        <summary>
                          <b>{p.mealType}（{p.window}）</b>{' '}
                          <span className="mono muted">
                            {formatMs(Date.parse(p.openAt), DISPLAY_OFFSET_MINUTES)} — {formatMs(Date.parse(p.closeAt), DISPLAY_OFFSET_MINUTES)}
                          </span>{' '}
                          {p.adjustment && <Badge tone="candidate">临时调整</Badge>}{' '}
                          <span className="muted" style={{ fontSize: 12 }}>
                            确认 {counts?.confirmed ?? 0} · 候选 {counts?.candidate ?? 0} · 冲突 {counts?.conflict ?? 0} · 缺据 {counts?.ungrounded ?? 0}
                          </span>
                        </summary>
                        <EventTable events={events} onOpenEvent={onOpenEvent} />
                      </details>
                    );
                  })}
                </div>
              ))}
              {(() => {
                const unassigned = run.events.filter((e) => e.schoolId === school && e.periodIds.length === 0);
                if (unassigned.length === 0) return null;
                return (
                  <>
                    <h3>未能归属到供餐周期的事件（{unassigned.length}）</h3>
                    <EventTable events={unassigned} onOpenEvent={onOpenEvent} />
                  </>
                );
              })()}
            </div>
          ))}
        </>
      ) : (
        <div className="card">
          <h2>按入库日（资料收到时间）分组</h2>
          {arrivalGroups.map(([day, events]) => (
            <div key={day} style={{ marginBottom: 14 }}>
              <h3>入库日 {day}（{events.length} 条事件）</h3>
              <EventTable events={events} onOpenEvent={onOpenEvent} />
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>全部事件（{run.events.length}）</h2>
        <div className="filter-bar">
          {(['', 'CONFIRMED', 'CANDIDATE', 'CONFLICT', 'UNGROUNDED'] as const).map((f) => (
            <button key={f} className={`btn small ${statusFilter === f ? 'primary' : ''}`} onClick={() => setStatusFilter(f)}>
              {f === '' ? '全部' : f === 'CONFIRMED' ? '已确认' : f === 'CANDIDATE' ? '仍有候选' : f === 'CONFLICT' ? '时间冲突' : '缺少依据'}
            </button>
          ))}
        </div>
        <EventTable
          events={statusFilter ? run.events.filter((e) => e.status === statusFilter) : run.events}
          onOpenEvent={onOpenEvent}
        />
      </div>
    </>
  );
}

function EventTable({
  events,
  onOpenEvent,
}: {
  events: CorrelatedEvent[];
  onOpenEvent: (eventKey: string) => void;
}) {
  if (events.length === 0) return <p className="muted" style={{ margin: '6px 0' }}>（无事件）</p>;
  return (
    <table className="data">
      <thead>
        <tr><th>事件</th><th>类型</th><th>状态</th><th>时间范围（{DISPLAY_TZ_LABEL}）</th><th>归属周期</th><th></th></tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.eventKey}>
            <td>
              {e.label}
              {e.duplicateOf && <Badge tone="neutral">重复上报</Badge>}
            </td>
            <td>{EVENT_TYPE_LABEL[e.eventType]}</td>
            <td><CorrelationBadge status={e.status} /></td>
            <td className="mono nowrap" style={{ fontSize: 12 }}>
              {e.time.precision === 'date' ? e.time.rawText + ' 全天' : formatRange(e.time, DISPLAY_OFFSET_MINUTES)}
              {e.time.correction && <span className="muted">（校时 {e.time.correction.offsetMinutes}min）</span>}
            </td>
            <td className="mono" style={{ fontSize: 12 }}>{e.periodIds.join('、') || '—'}</td>
            <td><button className="btn small" onClick={() => onOpenEvent(e.eventKey)}>详情</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- 事件抽屉 ----------

function EventDrawer({ event, run, onClose }: { event: CorrelatedEvent; run: CorrelationRun; onClose: () => void }) {
  const { dataset } = useAppState();
  const periodById = new Map(run.periods.map((p) => [p.periodId, p]));
  return (
    <Drawer title={event.label} subtitle={`${EVENT_TYPE_LABEL[event.eventType]} · ${event.eventKey}`} onClose={onClose}>
      <dl className="kv-list">
        <dt>关联结果</dt>
        <dd><CorrelationBadge status={event.status} /> {event.duplicateOf && <Badge tone="neutral">重复上报 → {event.duplicateOf}</Badge>}</dd>
        <dt>依据说明</dt>
        <dd>{event.basisNote}</dd>
        {event.conflictNote && (
          <>
            <dt>冲突说明</dt>
            <dd style={{ color: 'var(--issue)' }}>{event.conflictNote}</dd>
          </>
        )}
        <dt>原始时间文本</dt>
        <dd className="mono">{event.time.rawText}（精度：{event.time.precision}）</dd>
        <dt>标准化时间范围</dt>
        <dd className="mono">{formatRange(event.time, DISPLAY_OFFSET_MINUTES)}（{DISPLAY_TZ_LABEL}）</dd>
        {event.timeEnd && (
          <>
            <dt>完成时间（原文）</dt>
            <dd className="mono">{event.timeEnd.rawText} → {formatRange(event.timeEnd, DISPLAY_OFFSET_MINUTES)}</dd>
          </>
        )}
        <dt>时区解释</dt>
        <dd>{event.time.timezoneNote}</dd>
        <dt>所用校时依据</dt>
        <dd>
          {event.time.correction ? (
            <>
              <span className="mono">{event.time.correction.segmentId}（{event.time.correction.offsetMinutes} 分钟）</span>
              <br />{event.time.correction.evidence}
            </>
          ) : (
            '无校时（按原始时间使用）'
          )}
        </dd>
        <dt>资料收到时间</dt>
        <dd className="mono">{event.receivedAt ?? '未知'}（批次 {event.batchId}）</dd>
        {event.window && <><dt>记录窗口</dt><dd>{event.window}</dd></>}
        {event.productionRef && <><dt>明确引用</dt><dd className="mono">制作批次 {event.productionRef}</dd></>}
        {event.issueRefs.length > 0 && <><dt>回引领料</dt><dd className="mono">{event.issueRefs.join('、')}</dd></>}
        {event.servingUid && <><dt>物理事件标识</dt><dd className="mono">{event.servingUid}</dd></>}
        {event.referenceChain.length > 0 && (
          <>
            <dt>引用链</dt>
            <dd className="mono">{event.referenceChain.join(' → ')}</dd>
          </>
        )}
        <dt>归属供餐周期</dt>
        <dd>
          {event.periodIds.length === 0
            ? '（无）'
            : event.periodIds.map((id) => {
                const p = periodById.get(id);
                return (
                  <div key={id} className="mono">
                    {id}{p ? `（${p.mealType} ${p.businessDay}）` : ''}
                  </div>
                );
              })}
        </dd>
      </dl>

      {event.candidates.length > 0 && (
        <>
          <h3 style={{ margin: '14px 0 8px' }}>候选周期与排除理由</h3>
          <table className="data">
            <thead>
              <tr><th>周期</th><th>状态</th><th>理由</th></tr>
            </thead>
            <tbody>
              {event.candidates.map((c) => (
                <tr key={c.periodId}>
                  <td className="mono">{c.periodId}</td>
                  <td>{c.excluded ? <Badge tone="issue">已排除</Badge> : <Badge tone="candidate">候选</Badge>}</td>
                  <td>{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 style={{ margin: '14px 0 8px' }}>涉及的原始行</h3>
      {event.relatedRowIds.map((rid) => {
        const row = dataset ? findRawRow(dataset, rid) : undefined;
        return row ? (
          <RawRowView key={rid} batchId={row.batchId} lineNo={row.lineNo} values={row.values} />
        ) : (
          <div key={rid} className="raw-row mono">{rid}</div>
        );
      })}
    </Drawer>
  );
}
