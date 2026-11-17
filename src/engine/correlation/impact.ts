// 更正影响预览：更正时间解释、补录转供记录或修订日历时，
// 先展示原归属、候选变化和受影响餐次，再生成新的分析运行。
// 影响范围同时检查原时间位置和更正后位置——记录从原餐次移走时，
// 两边的计数与未知范围都要更新；日历修订还需检查以前没有任何候选的记录。

import type {
  CorrelationImpact,
  CorrelationRun,
  CorrelationStatus,
  PeriodStatusCounts,
} from '../../types';
import { correlateSync, type CorrelationInput } from './correlate';

function emptyCounts(periodId: string): PeriodStatusCounts {
  return { periodId, confirmed: 0, candidate: 0, conflict: 0, ungrounded: 0 };
}

export function previewCorrelationImpact(
  kind: CorrelationImpact['kind'],
  beforeInput: CorrelationInput,
  afterInput: CorrelationInput,
): CorrelationImpact {
  const before = correlateSync({ ...beforeInput, runId: 'PREVIEW-BEFORE' }, 'sweep');
  const after = correlateSync({ ...afterInput, runId: 'PREVIEW-AFTER' }, 'sweep');

  const beforeByKey = new Map(before.events.map((e) => [e.eventKey, e]));
  const changed: CorrelationImpact['changed'] = [];
  const affected = new Set<string>();

  after.events.forEach((a) => {
    const b = beforeByKey.get(a.eventKey);
    const bStatus: CorrelationStatus = b?.status ?? 'UNGROUNDED';
    const bPeriods = b?.periodIds ?? [];
    const same =
      b !== undefined &&
      b.status === a.status &&
      JSON.stringify([...b.periodIds].sort()) === JSON.stringify([...a.periodIds].sort());
    if (same) return;
    changed.push({
      eventKey: a.eventKey,
      label: a.label,
      before: { status: bStatus, periodIds: bPeriods },
      after: { status: a.status, periodIds: a.periodIds },
    });
    // 原位置与新位置都计入影响范围
    bPeriods.forEach((p) => affected.add(p));
    a.periodIds.forEach((p) => affected.add(p));
  });

  const countOf = (
    run: typeof before,
    periodId: string,
  ): PeriodStatusCounts =>
    run.summary.perPeriod.find((r) => r.periodId === periodId) ?? emptyCounts(periodId);

  const affectedPeriods = Array.from(affected)
    .sort()
    .map((pid) => ({ periodId: pid, before: countOf(before, pid), after: countOf(after, pid) }));

  // 此前没有任何候选、更正后首次进入范围的记录（日历修订必须检查这一类）
  const newlyCandidate = changed
    .filter((c) => c.before.periodIds.length === 0 && c.before.status === 'UNGROUNDED' && c.after.periodIds.length > 0)
    .map((c) => c.eventKey);

  return {
    kind,
    changed,
    affectedPeriods,
    newlyCandidate,
    beforeCounts: before.summary.counts,
    afterCounts: after.summary.counts,
  };
}

// ---------- 两个已保存运行之间的差异（更正前后对比） ----------

export interface CorrelationRunDiff {
  baseRunId: string;
  targetRunId: string;
  changed: CorrelationImpact['changed'];
  beforeCounts: Record<CorrelationStatus, number>;
  afterCounts: Record<CorrelationStatus, number>;
}

export function diffCorrelationRuns(base: CorrelationRun, target: CorrelationRun): CorrelationRunDiff {
  const baseByKey = new Map(base.events.map((e) => [e.eventKey, e]));
  const changed: CorrelationImpact['changed'] = [];
  target.events.forEach((a) => {
    const b = baseByKey.get(a.eventKey);
    const bPeriods = b?.periodIds ?? [];
    const same =
      b !== undefined &&
      b.status === a.status &&
      JSON.stringify([...b.periodIds].sort()) === JSON.stringify([...a.periodIds].sort());
    if (same) return;
    changed.push({
      eventKey: a.eventKey,
      label: a.label,
      before: { status: b?.status ?? 'UNGROUNDED', periodIds: bPeriods },
      after: { status: a.status, periodIds: a.periodIds },
    });
  });
  return {
    baseRunId: base.summary.runId,
    targetRunId: target.summary.runId,
    changed,
    beforeCounts: base.summary.counts,
    afterCounts: target.summary.counts,
  };
}
