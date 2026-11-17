import { describe, expect, it } from 'vitest';
import { loadTestDataset } from '../../test/loadTestDataset';
import { correlateSync, type CorrelationInput } from './correlate';
import { executeCorrelationTask, CORRELATION_STAGES } from './runCorrelation';
import type { CorrelationTask } from '../../types';

const dataset = await loadTestDataset();

function makeInput(): CorrelationInput {
  return {
    dataset,
    timeSettings: dataset.timeSettingsSeed,
    calendar: dataset.calendarSeed,
    relations: dataset.relationsSeed,
    runId: 'CRUN-ASYNC',
    createdAt: '2026-09-06T10:00:00.000Z',
    mappingVersion: dataset.seedMapping.mappingVersion,
    mappingRevision: 1,
    revisions: { timeSettings: 1, calendar: 1, relations: 1 },
  };
}

function makeTask(generation = 1): CorrelationTask {
  return {
    taskId: 'TASK-ASYNC-1',
    label: '测试任务',
    scope: { schoolIds: [], businessDays: [] },
    status: 'RUNNING',
    progress: { done: 0, total: 1, stage: '排队中' },
    createdAt: '2026-09-06T10:00:00.000Z',
    generation,
  };
}

describe('异步关联任务运行器', () => {
  it('异步分片执行与同步整批结果完全一致', async () => {
    const task = makeTask();
    const stages: string[] = [];
    const run = await executeCorrelationTask(task, makeInput(), {
      chunkSize: 5,
      onProgress: (t) => {
        stages.push(t.progress.stage);
      },
      shouldCancel: () => false,
      isStale: () => false,
    });
    expect(run).not.toBeNull();
    const sync = correlateSync({ ...makeInput(), taskId: 'TASK-ASYNC-1' });
    expect(run!.events).toEqual(sync.events);
    expect(run!.summary.counts).toEqual(sync.summary.counts);
    expect(run!.summary.uniqueServings).toBe(sync.summary.uniqueServings);
    // 全部阶段都有进度回报
    CORRELATION_STAGES.forEach((s) => expect(stages).toContain(s));
  });

  it('取消后返回 null，不产生结果', async () => {
    const task = makeTask();
    let calls = 0;
    const run = await executeCorrelationTask(task, makeInput(), {
      chunkSize: 3,
      onProgress: () => {
        calls += 1;
      },
      shouldCancel: () => calls >= 2, // 第二个进度回报后请求取消
      isStale: () => false,
    });
    expect(run).toBeNull();
  });

  it('代际过期（已有更新任务）返回 null，不覆盖新范围', async () => {
    const task = makeTask(1);
    const run = await executeCorrelationTask(task, makeInput(), {
      chunkSize: 100,
      onProgress: () => undefined,
      shouldCancel: () => false,
      isStale: (t) => t.generation !== 2, // 当前代际已是 2
    });
    expect(run).toBeNull();
  });
});
