import { openDB, type IDBPDatabase } from 'idb';
import type { AnalysisRun, CorrelationRun, CorrelationTask, MappingState } from '../types';

const DB_NAME = 'campus-meal-dq';
const DB_VERSION = 2;

export interface SnapshotRecord {
  id: string;
  kind: 'INPUT_SNAPSHOT' | 'MAPPING_SNAPSHOT';
  payload: unknown;
  createdAt: string;
}

interface DBSchema {
  kv: { key: string; value: unknown };
  runs: { key: string; value: AnalysisRun };
  snapshots: { key: string; value: SnapshotRecord };
  correlationRuns: { key: string; value: CorrelationRun };
  correlationTasks: { key: string; value: CorrelationTask };
}

let dbPromise: Promise<IDBPDatabase<DBSchema>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<DBSchema>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('kv')) {
          database.createObjectStore('kv', { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains('runs')) {
          database.createObjectStore('runs', { keyPath: 'summary.runId' });
        }
        if (!database.objectStoreNames.contains('snapshots')) {
          database.createObjectStore('snapshots', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('correlationRuns')) {
          database.createObjectStore('correlationRuns', { keyPath: 'summary.runId' });
        }
        if (!database.objectStoreNames.contains('correlationTasks')) {
          database.createObjectStore('correlationTasks', { keyPath: 'taskId' });
        }
      },
    });
  }
  return dbPromise;
}

// ---------- KV（映射状态等单例对象） ----------

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const rec = await (await db()).get('kv', key);
  return rec ? (rec as { value: T }).value : undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', { key, value });
}

// ---------- 分析运行 ----------

export async function saveRun(run: AnalysisRun): Promise<void> {
  await (await db()).put('runs', run);
}

export async function getAllRuns(): Promise<AnalysisRun[]> {
  const runs = await (await db()).getAll('runs');
  return runs.sort((a, b) => b.summary.createdAt.localeCompare(a.summary.createdAt));
}

export async function getRun(runId: string): Promise<AnalysisRun | undefined> {
  return (await db()).get('runs', runId);
}

export async function deleteRun(runId: string): Promise<void> {
  await (await db()).delete('runs', runId);
}

// ---------- 快照 ----------

export async function saveSnapshot(rec: SnapshotRecord): Promise<void> {
  await (await db()).put('snapshots', rec);
}

export async function getAllSnapshots(): Promise<SnapshotRecord[]> {
  const recs = await (await db()).getAll('snapshots');
  return recs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function clearAll(): Promise<void> {
  const database = await db();
  await Promise.all([
    database.clear('kv'),
    database.clear('runs'),
    database.clear('snapshots'),
    database.clear('correlationRuns'),
    database.clear('correlationTasks'),
  ]);
}

// ---------- 时间关联：运行与任务 ----------

export async function saveCorrelationRun(run: CorrelationRun): Promise<void> {
  await (await db()).put('correlationRuns', run);
}

export async function getAllCorrelationRuns(): Promise<CorrelationRun[]> {
  const runs = await (await db()).getAll('correlationRuns');
  return runs.sort((a, b) => b.summary.createdAt.localeCompare(a.summary.createdAt));
}

export async function deleteCorrelationRun(runId: string): Promise<void> {
  await (await db()).delete('correlationRuns', runId);
}

export async function saveCorrelationTask(task: CorrelationTask): Promise<void> {
  await (await db()).put('correlationTasks', task);
}

export async function getAllCorrelationTasks(): Promise<CorrelationTask[]> {
  const tasks = await (await db()).getAll('correlationTasks');
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteCorrelationTask(taskId: string): Promise<void> {
  await (await db()).delete('correlationTasks', taskId);
}

export const KV_KEYS = {
  mappingState: 'mapping-state',
  lastDataset: 'last-dataset',
  timeSettingsState: 'time-settings-state',
  calendarState: 'calendar-state',
  relationsState: 'relations-state',
  latestCorrelationRun: 'latest-correlation-run',
} as const;

export type { MappingState };
