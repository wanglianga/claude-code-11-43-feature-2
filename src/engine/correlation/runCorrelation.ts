// 关联任务异步运行器：分片执行，界面不失去响应
// - 显示处理范围与进度（阶段 + 已处理事件数）
// - 支持取消后重新执行；代际号防止旧任务晚完成覆盖用户刚启动的新范围
// - 任务状态持久化到 IndexedDB，刷新页面后可恢复未完成任务的状态

import type { CorrelatedEvent, CorrelationRun, CorrelationTask } from '../../types';
import {
  attachCandidatesSweep,
  classifyIssueEvent,
  classifyProductionEvent,
  classifyServingEvent,
  createPlanShell,
  eventSpecsFor,
  markDuplicateServings,
  normalizeEventInto,
  sortEventsByTime,
  summarizeRun,
  type CorrelationInput,
} from './correlate';

export interface RunnerHooks {
  onProgress: (task: CorrelationTask) => void | Promise<void>;
  /** 用户请求取消 */
  shouldCancel: (taskId: string) => boolean;
  /** 代际检查：已有更新的任务启动，本任务结果不得覆盖新范围 */
  isStale: (task: CorrelationTask) => boolean;
  chunkSize?: number;
}

const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const CORRELATION_STAGES = [
  '装配供餐周期与事件',
  '规范化时间',
  '统一排序与顺序扫描',
  '判定关联',
  '汇总结果',
] as const;

/**
 * 执行一个关联任务。返回 null 表示被取消或已被更新任务取代（调用方负责落盘任务状态）。
 * 与同步路径 correlateSync 共用同一套分步函数，结果一致。
 */
export async function executeCorrelationTask(
  task: CorrelationTask,
  input: CorrelationInput,
  hooks: RunnerHooks,
): Promise<CorrelationRun | null> {
  const chunkSize = hooks.chunkSize ?? 100;
  const aborted = () => hooks.shouldCancel(task.taskId) || hooks.isStale(task);
  const report = async (stage: string, done: number, total: number) => {
    task.progress = { stage, done, total };
    await hooks.onProgress(task);
  };

  // 阶段 1：装配
  await report(CORRELATION_STAGES[0], 0, 1);
  const plan = createPlanShell({ ...input, taskId: task.taskId });
  const specs = eventSpecsFor(plan);
  const total = Math.max(specs.length, 1);
  await report(CORRELATION_STAGES[0], 1, 1);
  if (aborted()) return null;
  await sleep();

  // 阶段 2：规范化（分片，让出主线程）
  for (let i = 0; i < specs.length; i++) {
    normalizeEventInto(plan, specs[i]);
    if ((i + 1) % chunkSize === 0 || i === specs.length - 1) {
      await report(CORRELATION_STAGES[1], i + 1, total);
      if (aborted()) return null;
      await sleep();
    }
  }

  // 阶段 3：统一排序 + 顺序扫描（主路径；对照路径见 correlateRowByRow）
  await report(CORRELATION_STAGES[2], 0, total);
  attachCandidatesSweep(plan);
  await report(CORRELATION_STAGES[2], total, total);
  if (aborted()) return null;
  await sleep();

  // 阶段 4：按依赖顺序判定（发餐 → 制作 → 领料），分片让出主线程
  const servings = sortEventsByTime(plan.events.filter((e) => e.eventType === 'SERVING'));
  const productions = sortEventsByTime(plan.events.filter((e) => e.eventType === 'PRODUCTION'));
  const issues = sortEventsByTime(plan.events.filter((e) => e.eventType === 'ISSUE'));

  const servingResults: CorrelatedEvent[] = [];
  const servingsByProduction = new Map<string, CorrelatedEvent[]>();
  const productionResults = new Map<string, CorrelatedEvent>();
  const issueResults: CorrelatedEvent[] = [];

  let done = 0;
  const classifyTotal = Math.max(servings.length + productions.length + issues.length, 1);

  for (const e of servings) {
    const r = classifyServingEvent(e, plan);
    servingResults.push(r);
    if (r.productionRef) {
      const list = servingsByProduction.get(r.productionRef) ?? [];
      list.push(r);
      servingsByProduction.set(r.productionRef, list);
    }
    done += 1;
    if (done % chunkSize === 0) {
      await report(CORRELATION_STAGES[3], done, classifyTotal);
      if (aborted()) return null;
      await sleep();
    }
  }
  for (const e of productions) {
    productionResults.set(e.eventKey, classifyProductionEvent(e, plan, servingsByProduction));
    done += 1;
    if (done % chunkSize === 0) {
      await report(CORRELATION_STAGES[3], done, classifyTotal);
      if (aborted()) return null;
      await sleep();
    }
  }
  for (const e of issues) {
    issueResults.push(classifyIssueEvent(e, plan, productionResults));
    done += 1;
    if (done % chunkSize === 0 || done === classifyTotal) {
      await report(CORRELATION_STAGES[3], done, classifyTotal);
      if (aborted()) return null;
      await sleep();
    }
  }

  markDuplicateServings(servingResults);
  const events = [...servingResults, ...productions.map((e) => productionResults.get(e.eventKey)!), ...issueResults].sort(
    (a, b) => a.time.earliestMs - b.time.earliestMs || a.eventKey.localeCompare(b.eventKey),
  );

  // 阶段 5：汇总
  await report(CORRELATION_STAGES[4], 0, 1);
  const run = summarizeRun(plan, events);
  await report(CORRELATION_STAGES[4], 1, 1);
  if (aborted()) return null;
  return run;
}
