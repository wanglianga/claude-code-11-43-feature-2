// 供餐周期与多源事件时间关联引擎
//
// 实现路径选择（针对“本地批量导入 + 反复局部更正”的使用方式）：
//   主路径 = 统一排序 + 顺序扫描（整批重建）。每次更正都生成新的不可变运行，
//   整批重建一次排序、一次扫描即可得到全部关联，重复读取可控；
//   代价是晚到一条旧事件需要重新整理相关时间段，且排序占用 O(n) 临时空间。
//   对照路径 = 逐条暴力计算（correlateRowByRow）：每条事件遍历全部周期，
//   相当于“按学校/窗口/时间范围按需关联”的索引路径在单条上的退化形式，
//   两条路径必须产生完全相同的关联结果——测试固化这一点，不允许以漏掉
//   跨日/跨窗口边界记录换取速度。

import type {
  BatchRelationsDocument,
  CandidatePeriod,
  CorrelatedEvent,
  CorrelationEventType,
  CorrelationRun,
  CorrelationRunSummary,
  CorrelationScope,
  CorrelationStatus,
  NormalizedTime,
  ServingCalendarDocument,
  ServingPeriod,
  SourceTimeProfile,
  TimeSettingsDocument,
  TransferRecord,
} from '../../types';
import type { Dataset } from '../../lib/loadDataset';
import { batchSchool } from '../context';
import {
  MINUTE_MS,
  normalizeTime,
  parseOffsetMinutes,
  rangesOverlap,
} from './timeNorm';

export const CORRELATION_RULE_VERSION = 'corr-rules-v1';

/** 领料候选前瞻窗口：晚间领出的原料可能用于次日餐次，候选生成允许 36 小时前瞻 */
export const ISSUE_LOOKAHEAD_MS = 36 * 60 * MINUTE_MS;

/** 提前备餐容忍：制作完成时间落在窗口外时，把“完成后下一个即将开放的窗口”视为其主餐次 */
export const PREP_AHEAD_MS = 6 * 60 * MINUTE_MS;

export interface CorrelationInput {
  dataset: Dataset;
  timeSettings: TimeSettingsDocument;
  calendar: ServingCalendarDocument;
  relations: BatchRelationsDocument;
  scope?: CorrelationScope;
  runId?: string;
  taskId?: string;
  createdAt?: string;
  mappingVersion?: string;
  mappingRevision?: number;
  revisions?: { timeSettings: number; calendar: number; relations: number };
}

export interface PeriodInterval extends ServingPeriod {
  openMs: number;
  closeMs: number;
}

/** 装配并规范化后的来源事件 */
export interface NormalizedEvent {
  eventKey: string;
  eventType: CorrelationEventType;
  refId: string;
  rowId: string;
  batchId: string;
  receivedAt: string | null;
  schoolId: string;
  device: string;
  label: string;
  window: string;
  servingUid: string;
  productionRef: string;
  issueRefs: string[];
  itemText: string;
  time: NormalizedTime | null;
  timeEnd: NormalizedTime | null;
  timeError?: string;
  overlappingPeriods: PeriodInterval[];
  candidateProductions: NormalizedEvent[];
}

export interface CorrelationPlan {
  dataset: Dataset;
  timeSettings: TimeSettingsDocument;
  calendar: ServingCalendarDocument;
  relations: BatchRelationsDocument;
  scope: CorrelationScope;
  runId: string;
  taskId: string;
  createdAt: string;
  mappingVersion: string;
  mappingRevision: number;
  revisions: { timeSettings: number; calendar: number; relations: number };
  periods: PeriodInterval[];
  events: NormalizedEvent[];
  productionsByRef: Map<string, NormalizedEvent>;
  transfersByProduction: Map<string, TransferRecord[]>;
}

// ---------- 步骤 1：装配 + 规范化 ----------

function normalizeInput(input: CorrelationInput) {
  const schools = new Set<string>();
  input.calendar.periods.forEach((p) => schools.add(p.schoolId));
  input.dataset.manifest.batches.forEach((b) => {
    if (b.schoolId !== '*') schools.add(b.schoolId);
  });
  const scope: CorrelationScope = {
    schoolIds: input.scope?.schoolIds?.length ? [...input.scope.schoolIds] : Array.from(schools).sort(),
    businessDays: input.scope?.businessDays?.length
      ? [...input.scope.businessDays]
      : Array.from(new Set(input.calendar.periods.map((p) => p.businessDay))).sort(),
  };
  return {
    scope,
    runId: input.runId ?? `CRUN-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    taskId: input.taskId ?? '',
    createdAt: input.createdAt ?? new Date().toISOString(),
    mappingVersion: input.mappingVersion ?? '',
    mappingRevision: input.mappingRevision ?? 0,
    revisions: input.revisions ?? { timeSettings: 0, calendar: 0, relations: 0 },
  };
}

function profileFor(
  timeSettings: TimeSettingsDocument,
  sourceType: string,
  schoolId: string,
): SourceTimeProfile | undefined {
  return timeSettings.sources.find(
    (s) =>
      s.appliesTo.sourceTypes.includes(sourceType as SourceTimeProfile['appliesTo']['sourceTypes'][number]) &&
      (s.appliesTo.schoolId === '*' || s.appliesTo.schoolId === schoolId),
  );
}

function fieldTimezone(profile: SourceTimeProfile | undefined, field: string): string | null {
  return profile?.fields.find((f) => f.field === field)?.timezone ?? null;
}

interface RawEventSpec {
  eventType: CorrelationEventType;
  refId: string;
  rowId: string;
  batchId: string;
  schoolId: string;
  device: string;
  label: string;
  window: string;
  servingUid: string;
  productionRef: string;
  issueRefs: string[];
  itemText: string;
  rawTime: string;
  rawTimeEnd?: string;
  timeField: string;
  timeEndField?: string;
  sourceType: 'material_issues' | 'production_batches' | 'serving_events';
}

function assembleEvents(dataset: Dataset, schools: Set<string>): RawEventSpec[] {
  const out: RawEventSpec[] = [];

  for (const batch of dataset.loadedBatches) {
    const t = batch.meta.sourceType;
    if (t !== 'material_issues' && t !== 'production_batches' && t !== 'serving_events') continue;
    for (const row of batch.rows) {
      const v = row.values;
      if (t === 'material_issues') {
        const schoolId = batchSchool(dataset, row.batchId);
        if (!schools.has(schoolId)) continue;
        out.push({
          eventType: 'ISSUE',
          refId: v.issue_id ?? '',
          rowId: row.rowId,
          batchId: row.batchId,
          schoolId,
          device: v.device ?? '',
          label: `领料 ${v.issue_id} · ${v.item_text || '（未填原料）'}`,
          window: '',
          servingUid: '',
          productionRef: (v.production_ref ?? '').trim(),
          issueRefs: [],
          itemText: v.item_text ?? '',
          rawTime: v.issued_at ?? '',
          timeField: 'issued_at',
          sourceType: t,
        });
      } else if (t === 'production_batches') {
        const schoolId = batchSchool(dataset, row.batchId);
        if (!schools.has(schoolId)) continue;
        out.push({
          eventType: 'PRODUCTION',
          refId: v.production_id ?? '',
          rowId: row.rowId,
          batchId: row.batchId,
          schoolId,
          device: v.device ?? '',
          label: `制作 ${v.production_id} · ${v.dish_name || v.recipe_id || ''}`,
          window: '',
          servingUid: '',
          productionRef: '',
          issueRefs: (v.issue_refs ?? '').split(';').map((s) => s.trim()).filter(Boolean),
          itemText: v.dish_name ?? '',
          rawTime: v.start_at ?? '',
          rawTimeEnd: v.finish_at ?? '',
          timeField: 'start_at',
          timeEndField: 'finish_at',
          sourceType: t,
        });
      } else {
        const schoolId = (v.school_id ?? '').trim() || batchSchool(dataset, row.batchId);
        if (!schools.has(schoolId)) continue;
        out.push({
          eventType: 'SERVING',
          refId: v.event_id ?? '',
          rowId: row.rowId,
          batchId: row.batchId,
          schoolId,
          device: v.device ?? '',
          label: `发餐 ${v.event_id} · ${v.window || '未填窗口'}`,
          window: (v.window ?? '').trim(),
          servingUid: (v.serving_uid ?? '').trim(),
          productionRef: (v.production_ref ?? '').trim(),
          issueRefs: [],
          itemText: '',
          rawTime: v.served_at ?? '',
          timeField: 'served_at',
          sourceType: t,
        });
      }
    }
  }
  return out;
}

function normalizeEvent(spec: RawEventSpec, plan: CorrelationPlan): NormalizedEvent {
  const profile = profileFor(plan.timeSettings, spec.sourceType, spec.schoolId);
  const schoolOffset = parseOffsetMinutes(
    plan.timeSettings.schoolTimezones[spec.schoolId] ?? '+08:00',
  ) ?? 480;
  const corrections = profile?.clockCorrections ?? [];

  const main = normalizeTime(spec.rawTime, {
    schoolOffsetMinutes: schoolOffset,
    declaredTimezone: fieldTimezone(profile, spec.timeField),
    corrections,
    device: spec.device,
  });

  let timeEnd: NormalizedTime | null = null;
  let timeEndError: string | undefined;
  if (spec.rawTimeEnd !== undefined && spec.timeEndField) {
    const end = normalizeTime(spec.rawTimeEnd, {
      schoolOffsetMinutes: schoolOffset,
      declaredTimezone: fieldTimezone(profile, spec.timeEndField),
      corrections,
      device: spec.device,
    });
    if (end.ok) timeEnd = end.time;
    else timeEndError = end.error;
  }

  const receivedAt =
    plan.dataset.manifest.batches.find((b) => b.batchId === spec.batchId)?.updatedAt ?? null;

  return {
    eventKey: `${spec.eventType}:${spec.refId}`,
    eventType: spec.eventType,
    refId: spec.refId,
    rowId: spec.rowId,
    batchId: spec.batchId,
    receivedAt,
    schoolId: spec.schoolId,
    device: spec.device,
    label: spec.label,
    window: spec.window,
    servingUid: spec.servingUid,
    productionRef: spec.productionRef,
    issueRefs: spec.issueRefs,
    itemText: spec.itemText,
    time: main.ok ? main.time : null,
    timeEnd,
    timeError: [!main.ok ? main.error : null, timeEndError ? `完成时间：${timeEndError}` : null]
      .filter(Boolean)
      .join('；') || undefined,
    overlappingPeriods: [],
    candidateProductions: [],
  };
}

/** 步骤 1a：构建计划壳（供餐周期 + 转供索引，事件尚未装配） */
export function createPlanShell(input: CorrelationInput): CorrelationPlan {
  const norm = normalizeInput(input);
  const periods: PeriodInterval[] = input.calendar.periods
    .filter(
      (p) =>
        norm.scope.schoolIds.includes(p.schoolId) &&
        norm.scope.businessDays.includes(p.businessDay),
    )
    .map((p) => ({ ...p, openMs: Date.parse(p.openAt), closeMs: Date.parse(p.closeAt) }))
    .filter((p) => Number.isFinite(p.openMs) && Number.isFinite(p.closeMs) && p.openMs < p.closeMs);

  const plan: CorrelationPlan = {
    dataset: input.dataset,
    timeSettings: input.timeSettings,
    calendar: input.calendar,
    relations: input.relations,
    scope: norm.scope,
    runId: norm.runId,
    taskId: norm.taskId,
    createdAt: norm.createdAt,
    mappingVersion: norm.mappingVersion,
    mappingRevision: norm.mappingRevision,
    revisions: norm.revisions,
    periods,
    events: [],
    productionsByRef: new Map(),
    transfersByProduction: new Map(),
  };
  input.relations.transfers.forEach((t) => {
    const list = plan.transfersByProduction.get(t.productionRef) ?? [];
    list.push(t);
    plan.transfersByProduction.set(t.productionRef, list);
  });
  return plan;
}

/** 步骤 1b：列出待规范化的事件规格（供分片处理） */
export function eventSpecsFor(plan: CorrelationPlan): RawEventSpec[] {
  return assembleEvents(plan.dataset, new Set(plan.scope.schoolIds));
}

/** 步骤 1c：规范化一条事件并挂入计划 */
export function normalizeEventInto(plan: CorrelationPlan, spec: RawEventSpec): NormalizedEvent {
  const e = normalizeEvent(spec, plan);
  plan.events.push(e);
  if (e.eventType === 'PRODUCTION') plan.productionsByRef.set(e.refId, e);
  return e;
}

/** 步骤 1：构建关联计划（供餐周期 + 全部规范化事件） */
export function createCorrelationPlan(input: CorrelationInput): CorrelationPlan {
  const plan = createPlanShell(input);
  eventSpecsFor(plan).forEach((s) => normalizeEventInto(plan, s));
  return plan;
}

// ---------- 步骤 2：候选装配（两条路径，结果必须一致） ----------

function eventRange(e: NormalizedEvent): [number, number] | null {
  if (e.eventType === 'SERVING' && e.time) return [e.time.earliestMs, e.time.latestMs];
  if (e.eventType === 'PRODUCTION' && e.timeEnd) return [e.timeEnd.earliestMs, e.timeEnd.latestMs];
  return null;
}

/** 主路径：统一排序 + 顺序扫描。周期与事件各自排序后一次扫描得到全部重叠候选 */
export function attachCandidatesSweep(plan: CorrelationPlan): void {
  const schools = plan.scope.schoolIds;
  for (const school of schools) {
    const periods = plan.periods
      .filter((p) => p.schoolId === school)
      .sort((a, b) => a.openMs - b.openMs || a.periodId.localeCompare(b.periodId));

    // 供餐周期候选：发餐按发餐时间、制作按完成时间
    const timed = plan.events
      .filter((e) => e.schoolId === school && eventRange(e) !== null)
      .sort((a, b) => {
        const ra = eventRange(a)![0];
        const rb = eventRange(b)![0];
        return ra - rb || a.eventKey.localeCompare(b.eventKey);
      });
    let pi = 0;
    let active: PeriodInterval[] = [];
    for (const e of timed) {
      const [s, en] = eventRange(e)!;
      while (pi < periods.length && periods[pi].openMs < en) active.push(periods[pi++]);
      active = active.filter((p) => p.closeMs > s);
      e.overlappingPeriods = active.filter((p) => rangesOverlap(s, en, p.openMs, p.closeMs));
    }

    // 领料的候选制作批次：开工时间不早于领料、且不超出前瞻窗口
    const productions = plan.events
      .filter((e) => e.schoolId === school && e.eventType === 'PRODUCTION' && e.time)
      .sort((a, b) => a.time!.earliestMs - b.time!.earliestMs || a.eventKey.localeCompare(b.eventKey));
    const issues = plan.events
      .filter((e) => e.schoolId === school && e.eventType === 'ISSUE' && e.time)
      .sort((a, b) => a.time!.earliestMs - b.time!.earliestMs || a.eventKey.localeCompare(b.eventKey));
    let qi = 0;
    let activeProd: NormalizedEvent[] = [];
    for (const issue of issues) {
      const lo = issue.time!.earliestMs;
      const hi = issue.time!.latestMs + ISSUE_LOOKAHEAD_MS;
      while (qi < productions.length && productions[qi].time!.earliestMs <= hi) {
        activeProd.push(productions[qi++]);
      }
      activeProd = activeProd.filter((p) => p.time!.earliestMs >= lo);
      issue.candidateProductions = activeProd.filter(
        (p) => p.time!.earliestMs >= lo && p.time!.earliestMs <= hi,
      );
    }
  }
}

/** 对照路径：每条事件独立遍历全部周期与制作批次（用于逐条核对，不漏跨日/跨窗口） */
export function attachCandidatesBrute(plan: CorrelationPlan): void {
  for (const e of plan.events) {
    const range = eventRange(e);
    if (range) {
      const [s, en] = range;
      e.overlappingPeriods = plan.periods
        .filter((p) => p.schoolId === e.schoolId && rangesOverlap(s, en, p.openMs, p.closeMs))
        .sort((a, b) => a.openMs - b.openMs || a.periodId.localeCompare(b.periodId));
    }
    if (e.eventType === 'ISSUE' && e.time) {
      const lo = e.time.earliestMs;
      const hi = e.time.latestMs + ISSUE_LOOKAHEAD_MS;
      e.candidateProductions = plan.events
        .filter(
          (p) =>
            p.eventType === 'PRODUCTION' &&
            p.schoolId === e.schoolId &&
            p.time !== null &&
            p.time.earliestMs >= lo &&
            p.time.earliestMs <= hi,
        )
        .sort((a, b) => a.time!.earliestMs - b.time!.earliestMs || a.eventKey.localeCompare(b.eventKey));
    }
  }
}

// ---------- 步骤 3：判定 ----------

function mealKey(p: PeriodInterval): string {
  return `${p.businessDay}|${p.mealType}`;
}

/**
 * 制作批次的主供餐周期：完成时间所在的开放区间；
 * 完成时间不在任何区间时（提前备餐），取完成后下一个即将开放的窗口。
 * 不把误差范围中点当真实时刻——区间判断只用半开区间重叠。
 */
export function primaryPeriodsForFinish(
  plan: CorrelationPlan,
  schoolId: string,
  finish: NormalizedTime,
): PeriodInterval[] {
  const periods = plan.periods.filter((p) => p.schoolId === schoolId);
  const containing = periods.filter((p) =>
    rangesOverlap(finish.earliestMs, finish.latestMs, p.openMs, p.closeMs),
  );
  if (containing.length > 0) return containing;
  const upcoming = periods.filter(
    (p) => p.openMs >= finish.earliestMs && p.openMs <= finish.earliestMs + PREP_AHEAD_MS,
  );
  if (upcoming.length === 0) return [];
  const minOpen = Math.min(...upcoming.map((p) => p.openMs));
  return upcoming.filter((p) => p.openMs === minOpen);
}

function periodIds(periods: PeriodInterval[]): string[] {
  return periods.map((p) => p.periodId).sort();
}

export function classifyServingEvent(
  e: NormalizedEvent,
  plan: CorrelationPlan,
): CorrelatedEvent {
  const base = baseResult(e);
  if (e.timeError || !e.time) {
    return finish(base, 'UNGROUNDED', [], [], `发餐时间无法解析：${e.timeError ?? '为空'}`);
  }
  const overlaps = e.overlappingPeriods;
  const windowMatched = e.window ? overlaps.filter((p) => p.window === e.window) : overlaps;
  const candidates: CandidatePeriod[] = overlaps.map((p) =>
    e.window && p.window !== e.window
      ? { periodId: p.periodId, excluded: true, reason: `窗口不一致（记录为 ${e.window}）` }
      : { periodId: p.periodId, excluded: false, reason: '发餐时间落在开放区间内' },
  );

  if (e.productionRef) {
    const prod = plan.productionsByRef.get(e.productionRef);
    base.referenceChain.push(`制作批次 ${e.productionRef}`);
    if (!prod) {
      return finish(base, 'UNGROUNDED', [], candidates, `明确引用的制作批次 ${e.productionRef} 不存在`, [e.rowId]);
    }
    base.relatedRowIds.push(prod.rowId);
    // 制作完成应早于相应批次发餐
    if (prod.timeEnd && prod.timeEnd.earliestMs > e.time.latestMs) {
      return finish(
        base,
        'CONFLICT',
        [],
        candidates,
        '明确引用与时间矛盾：制作完成时间晚于该批次发餐时间',
        [e.rowId, prod.rowId],
        `制作 ${prod.refId} 完成于 ${prod.timeEnd.rawText}，发餐 ${e.refId} 为 ${e.time.rawText}`,
      );
    }
    const primaryMeals = new Set(
      (prod.timeEnd ? primaryPeriodsForFinish(plan, e.schoolId, prod.timeEnd) : []).map(mealKey),
    );
    const sameMeal = windowMatched.filter((p) => primaryMeals.has(mealKey(p)));
    if (sameMeal.length > 0) {
      return finish(
        base,
        'CONFIRMED',
        periodIds(sameMeal),
        candidates,
        `明确引用制作批次 ${prod.refId}，发餐与制作为同一餐次，且完成早于发餐`,
      );
    }
    // 跨餐次：剩余制成品必须有转供依据
    const transfers = plan.transfersByProduction.get(prod.refId) ?? [];
    transfers.forEach((t) => base.referenceChain.push(`转供记录 ${t.transferId}`));
    const transferMatched = windowMatched.filter((p) =>
      transfers.some(
        (t) =>
          t.toSchoolId === p.schoolId && t.toWindow === p.window && t.toBusinessDay === p.businessDay,
      ),
    );
    if (transferMatched.length > 0) {
      const ids = transfers.map((t) => t.transferId).join('、');
      return finish(
        base,
        'CONFIRMED',
        periodIds(transferMatched),
        candidates,
        `明确引用制作批次 ${prod.refId}，跨餐次使用凭转供记录 ${ids} 成立`,
      );
    }
    if (windowMatched.length > 0) {
      windowMatched.forEach((p) => {
        const c = candidates.find((x) => x.periodId === p.periodId);
        if (c) c.reason = '跨餐次使用剩余制成品缺少转供依据，保留未知';
      });
      return finish(
        base,
        'UNGROUNDED',
        [],
        candidates,
        `引用制作批次 ${prod.refId} 的跨餐次使用缺少转供记录，不推断发生过或没有发生`,
        [e.rowId, prod.rowId],
      );
    }
    return finish(
      base,
      'CONFLICT',
      [],
      candidates,
      '明确引用与时间矛盾：发餐时间不落在引用链（制作批次/转供记录）指向的任何供餐周期',
      [e.rowId, prod.rowId],
      `引用链指向 ${Array.from(primaryMeals).join('、') || '（无）'}${transfers.length ? ` + 转供 ${transfers.map((t) => t.transferId).join('、')}` : ''}，发餐时间 ${e.time.rawText} 无对应开放区间`,
    );
  }

  // 无明确引用：候选仅说明尚可关联，不自动进入已确认
  if (windowMatched.length > 0) {
    return finish(
      base,
      'CANDIDATE',
      periodIds(windowMatched),
      candidates,
      '缺少明确引用：按学校、窗口与有效开放区间计算候选，候选不自动确认',
    );
  }
  if (overlaps.length > 0 && e.window) {
    return finish(
      base,
      'UNGROUNDED',
      [],
      candidates,
      `所填窗口「${e.window}」与发餐时间落在的开放区间不一致`,
    );
  }
  return finish(base, 'UNGROUNDED', [], candidates, '无明确引用且发餐时间不落在任何开放区间');
}

export function classifyProductionEvent(
  e: NormalizedEvent,
  plan: CorrelationPlan,
  servingsByProduction: Map<string, CorrelatedEvent[]>,
): CorrelatedEvent {
  const base = baseResult(e);
  if (e.timeError || !e.timeEnd) {
    return finish(base, 'UNGROUNDED', [], [], `制作时间无法解析：${e.timeError ?? '为空'}`);
  }
  const primary = primaryPeriodsForFinish(plan, e.schoolId, e.timeEnd);
  const candidates: CandidatePeriod[] = primary.map((p) => ({
    periodId: p.periodId,
    excluded: false,
    reason: rangesOverlap(p.openMs, p.closeMs, e.timeEnd!.earliestMs, e.timeEnd!.latestMs)
      ? '完成时间落在开放区间内'
      : '完成时间早于该窗口开放（提前备餐）',
  }));
  const transfers = plan.transfersByProduction.get(e.refId) ?? [];
  const transferPeriods = plan.periods.filter((p) =>
    transfers.some(
      (t) => t.toSchoolId === p.schoolId && t.toWindow === p.window && t.toBusinessDay === p.businessDay,
    ),
  );
  transferPeriods.forEach((p) => {
    if (!primary.some((x) => x.periodId === p.periodId)) {
      candidates.push({ periodId: p.periodId, excluded: false, reason: '转供记录指向该周期' });
    }
  });

  const referencedBy = servingsByProduction.get(e.refId) ?? [];
  const confirmedPeriods = new Set<string>();
  referencedBy.forEach((s) => {
    if (s.status === 'CONFIRMED') s.periodIds.forEach((id) => confirmedPeriods.add(id));
  });
  const conflictServings = referencedBy.filter((s) => s.status === 'CONFLICT');

  // 一次制作供应多个窗口/餐次时保留实际分流关系
  const all = new Set<string>([
    ...periodIds(primary),
    ...periodIds(transferPeriods),
    ...confirmedPeriods,
  ]);
  const periodIdList = Array.from(all).sort();

  if (confirmedPeriods.size > 0 || transferPeriods.length > 0) {
    const parts: string[] = [];
    if (confirmedPeriods.size > 0) parts.push('已确认发餐引用');
    if (transferPeriods.length > 0) parts.push(`转供记录 ${transfers.map((t) => t.transferId).join('、')}`);
    if (conflictServings.length > 0) {
      parts.push(`另有 ${conflictServings.length} 条发餐引用存在时间冲突（${conflictServings.map((s) => s.refId).join('、')}）`);
    }
    return finish(base, 'CONFIRMED', periodIdList, candidates, `有${parts.join('与')}，保留实际分流关系`);
  }
  if (primary.length > 0) {
    const conflictNote =
      conflictServings.length > 0
        ? `；发餐 ${conflictServings.map((s) => s.refId).join('、')} 与本批次存在时间冲突`
        : '';
    return finish(
      base,
      'CANDIDATE',
      periodIdList,
      candidates,
      `无已确认发餐/转供引用，仅按完成时间邻近归属${conflictNote}`,
    );
  }
  return finish(base, 'UNGROUNDED', [], candidates, '完成时间不落在任何开放区间，且无发餐/转供引用');
}

export function classifyIssueEvent(
  e: NormalizedEvent,
  plan: CorrelationPlan,
  productionResults: Map<string, CorrelatedEvent>,
): CorrelatedEvent {
  const base = baseResult(e);
  if (e.timeError || !e.time) {
    return finish(base, 'UNGROUNDED', [], [], `领料时间无法解析：${e.timeError ?? '为空'}`);
  }
  const linked = new Map<string, NormalizedEvent>();
  if (e.productionRef) {
    const p = plan.productionsByRef.get(e.productionRef);
    if (p) linked.set(p.eventKey, p);
  }
  plan.productionsByRef.forEach((p) => {
    if (p.issueRefs.includes(e.refId)) linked.set(p.eventKey, p);
  });

  if (e.productionRef && linked.size === 0) {
    return finish(base, 'UNGROUNDED', [], [], `明确引用的制作批次 ${e.productionRef} 不存在`, [e.rowId]);
  }

  if (linked.size > 0) {
    const linkedList = Array.from(linked.values());
    linkedList.forEach((p) => {
      base.referenceChain.push(`制作批次 ${p.refId}`);
      base.relatedRowIds.push(p.rowId);
    });
    // 领料应不晚于制作开工（仅说明物料进入厨房的顺序约束）
    const badOrder = linkedList.filter(
      (p) => p.time !== null && e.time!.earliestMs > p.time.latestMs,
    );
    if (e.productionRef && badOrder.some((p) => p.refId === e.productionRef)) {
      const referenced = linkedList.find((p) => p.refId === e.productionRef);
      return finish(
        base,
        'CONFLICT',
        [],
        [],
        '明确引用与时间矛盾：领料时间晚于所引用制作批次的开工时间',
        [e.rowId, ...linkedList.map((p) => p.rowId)],
        `领料 ${e.refId} 为 ${e.time.rawText}，制作 ${e.productionRef} 开工 ${referenced?.time?.rawText ?? '?'}`,
      );
    }
    const periodSet = new Set<string>();
    let productionUngrounded = false;
    linkedList.forEach((p) => {
      const r = productionResults.get(p.eventKey);
      if (r && r.periodIds.length > 0) r.periodIds.forEach((id) => periodSet.add(id));
      else productionUngrounded = true;
    });
    const oneWay = linkedList.filter((p) => !p.issueRefs.includes(e.refId)).map((p) => p.refId);
    const noteParts = [`明确引用制作批次 ${linkedList.map((p) => p.refId).join('、')}，领料不晚于开工`];
    if (oneWay.length > 0) noteParts.push(`（${oneWay.join('、')} 未回引该领料，引用为单向）`);
    if (periodSet.size === 0 || productionUngrounded) {
      return finish(
        base,
        'CANDIDATE',
        Array.from(periodSet).sort(),
        [],
        `${noteParts.join('')}；但所引用制作批次自身尚无法归属供餐周期`,
      );
    }
    return finish(base, 'CONFIRMED', Array.from(periodSet).sort(), [], noteParts.join(''));
  }

  // 无明确引用：领料仅说明物料进入厨房，不能单靠同日或相邻时刻证明实际投料
  if (e.candidateProductions.length > 0) {
    const periodSet = new Set<string>();
    e.candidateProductions.forEach((p) => {
      const r = productionResults.get(p.eventKey);
      r?.periodIds.forEach((id) => periodSet.add(id));
    });
    const candidates: CandidatePeriod[] = Array.from(periodSet)
      .sort()
      .map((id) => ({
        periodId: id,
        excluded: false,
        reason: `经由候选制作批次 ${e.candidateProductions.map((p) => p.refId).join('、')} 关联`,
      }));
    return finish(
      base,
      'CANDIDATE',
      Array.from(periodSet).sort(),
      candidates,
      '无明确引用：领料仅说明物料进入厨房，时间邻近不证明实际投料，候选不自动确认',
    );
  }
  return finish(base, 'UNGROUNDED', [], [], '无明确引用，且前瞻窗口内没有可关联的制作批次');
}

function baseResult(e: NormalizedEvent): CorrelatedEvent {
  return {
    eventKey: e.eventKey,
    eventType: e.eventType,
    refId: e.refId,
    rowId: e.rowId,
    batchId: e.batchId,
    receivedAt: e.receivedAt,
    schoolId: e.schoolId,
    device: e.device,
    label: e.label,
    time: e.time ?? placeholderTime(e.timeError),
    timeEnd: e.timeEnd ?? undefined,
    window: e.window,
    servingUid: e.servingUid,
    productionRef: e.productionRef,
    issueRefs: e.issueRefs,
    status: 'UNGROUNDED',
    periodIds: [],
    candidates: [],
    referenceChain: [],
    basisNote: '',
    relatedRowIds: [e.rowId],
  };
}

function placeholderTime(error?: string): NormalizedTime {
  return {
    rawText: error ? `（解析失败：${error}）` : '（空）',
    precision: 'instant',
    earliestMs: 0,
    latestMs: 0,
    timezoneNote: '不可用',
    correction: null,
  };
}

function finish(
  base: CorrelatedEvent,
  status: CorrelationStatus,
  periodIdsList: string[],
  candidates: CandidatePeriod[],
  basisNote: string,
  relatedRowIds?: string[],
  conflictNote?: string,
): CorrelatedEvent {
  base.status = status;
  base.periodIds = periodIdsList;
  base.candidates = candidates;
  base.basisNote = basisNote;
  if (relatedRowIds) base.relatedRowIds = Array.from(new Set([base.rowId, ...relatedRowIds]));
  if (conflictNote) base.conflictNote = conflictNote;
  return base;
}

/** 发餐去重：同一物理事件（serving_uid）被多来源重复记载只计一次；真实两次发餐（uid 不同）不合并 */
export function markDuplicateServings(servingResults: CorrelatedEvent[]): void {
  const groups = new Map<string, CorrelatedEvent[]>();
  servingResults.forEach((s) => {
    const key = s.servingUid ? `${s.schoolId}|${s.servingUid}` : `row|${s.rowId}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  });
  groups.forEach((list) => {
    if (list.length < 2) return;
    const sorted = [...list].sort(
      (a, b) => a.time.earliestMs - b.time.earliestMs || a.eventKey.localeCompare(b.eventKey),
    );
    const canonical = sorted[0];
    sorted.slice(1).forEach((dup) => {
      dup.duplicateOf = canonical.eventKey;
      dup.basisNote += `；与 ${canonical.eventKey} 为同一物理发餐事件的重复上报，唯一发餐数只计一次`;
    });
  });
}

export function sortEventsByTime<T extends NormalizedEvent>(events: T[]): T[] {
  return [...events].sort(
    (a, b) =>
      (a.time?.earliestMs ?? Number.MAX_SAFE_INTEGER) - (b.time?.earliestMs ?? Number.MAX_SAFE_INTEGER) ||
      a.eventKey.localeCompare(b.eventKey),
  );
}

/** 步骤 3：按依赖顺序判定全部事件（发餐 → 制作 → 领料） */
export function classifyPlan(plan: CorrelationPlan): CorrelatedEvent[] {
  const servings = sortEventsByTime(plan.events.filter((e) => e.eventType === 'SERVING'));
  const productions = sortEventsByTime(plan.events.filter((e) => e.eventType === 'PRODUCTION'));
  const issues = sortEventsByTime(plan.events.filter((e) => e.eventType === 'ISSUE'));

  const servingResults = servings.map((e) => classifyServingEvent(e, plan));

  const servingsByProduction = new Map<string, CorrelatedEvent[]>();
  servingResults.forEach((s) => {
    if (!s.productionRef) return;
    const list = servingsByProduction.get(s.productionRef) ?? [];
    list.push(s);
    servingsByProduction.set(s.productionRef, list);
  });

  const productionResults = new Map<string, CorrelatedEvent>();
  productions.forEach((e) => {
    productionResults.set(e.eventKey, classifyProductionEvent(e, plan, servingsByProduction));
  });

  const issueResults = issues.map((e) => classifyIssueEvent(e, plan, productionResults));

  markDuplicateServings(servingResults);

  const all = [...servingResults, ...productions.map((e) => productionResults.get(e.eventKey)!), ...issueResults];
  return all.sort(
    (a, b) => a.time.earliestMs - b.time.earliestMs || a.eventKey.localeCompare(b.eventKey),
  );
}

// ---------- 步骤 4：汇总 ----------

export function summarizeRun(plan: CorrelationPlan, events: CorrelatedEvent[]): CorrelationRun {
  const counts: Record<CorrelationStatus, number> = {
    CONFIRMED: 0,
    CANDIDATE: 0,
    CONFLICT: 0,
    UNGROUNDED: 0,
  };
  events.forEach((e) => {
    counts[e.status] += 1;
  });

  const servingGroups = new Set<string>();
  let servingEvents = 0;
  events.forEach((e) => {
    if (e.eventType !== 'SERVING') return;
    servingEvents += 1;
    servingGroups.add(e.servingUid ? `${e.schoolId}|${e.servingUid}` : `row|${e.rowId}`);
  });

  const perPeriod = plan.periods.map((p) => {
    const row = { periodId: p.periodId, confirmed: 0, candidate: 0, conflict: 0, ungrounded: 0 };
    events.forEach((e) => {
      if (!e.periodIds.includes(p.periodId)) return;
      if (e.status === 'CONFIRMED') row.confirmed += 1;
      else if (e.status === 'CANDIDATE') row.candidate += 1;
      else if (e.status === 'CONFLICT') row.conflict += 1;
      else row.ungrounded += 1;
    });
    return row;
  });

  const summary: CorrelationRunSummary = {
    runId: plan.runId,
    taskId: plan.taskId,
    createdAt: plan.createdAt,
    ruleVersion: CORRELATION_RULE_VERSION,
    timeSettingsVersion: plan.timeSettings.settingsVersion,
    timeSettingsRevision: plan.revisions.timeSettings,
    calendarVersion: plan.calendar.calendarVersion,
    calendarRevision: plan.revisions.calendar,
    relationsVersion: plan.relations.relationsVersion,
    relationsRevision: plan.revisions.relations,
    mappingVersion: plan.mappingVersion,
    mappingRevision: plan.mappingRevision,
    inputHashes: { ...plan.dataset.hashes, ...plan.dataset.metaHashes },
    scope: plan.scope,
    counts,
    uniqueServings: servingGroups.size,
    duplicateServingReports: servingEvents - servingGroups.size,
    perPeriod,
  };

  return {
    summary,
    events,
    periods: plan.periods.map(({ openMs: _o, closeMs: _c, ...p }) => p),
    transfers: plan.relations.transfers,
  };
}

// ---------- 对外入口 ----------

export type CorrelateStrategy = 'sweep' | 'brute';

/** 同步执行完整关联（strategy=sweep 为批处理主路径，brute 为逐条对照路径） */
export function correlateSync(input: CorrelationInput, strategy: CorrelateStrategy = 'sweep'): CorrelationRun {
  const plan = createCorrelationPlan(input);
  if (strategy === 'sweep') attachCandidatesSweep(plan);
  else attachCandidatesBrute(plan);
  const events = classifyPlan(plan);
  return summarizeRun(plan, events);
}

/** 小批样本逐条计算（对照路径）：确认批处理没有漏掉跨日和跨窗口关联 */
export function correlateRowByRow(input: CorrelationInput): CorrelationRun {
  return correlateSync(input, 'brute');
}
