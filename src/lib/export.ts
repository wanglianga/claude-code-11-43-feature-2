import type { AnalysisRun, CorrelationRun, CorrelationStatus, EvidenceBucket } from '../types';

export const BUCKET_LABEL: Record<EvidenceBucket, string> = {
  CONFIRMED: '有证据支持的匹配',
  CANDIDATE_PENDING: '存在候选但需确认',
  UNKNOWN_MISSING: '来源缺失无法判定',
};

/** 导出载荷：运行编号 + 口径摘要 + 未知范围，防止“无证据”被误读为“确认无过敏原” */
export interface RunExport {
  exportKind: 'allergen-coverage-run';
  exportedAt: string;
  runId: string;
  ruleVersion: string;
  mappingVersion: string;
  mappingRevision: number;
  inputFileHashes: Record<string, string>;
  caliberSummary: {
    confirmed: string;
    candidate: string;
    unknown: string;
    plannedExcluded: string;
  };
  coverage: AnalysisRun['summary']['coverage'];
  metricDetails: AnalysisRun['metricDetails'];
  unknownScope: Array<{
    servingId: string;
    studentAnonId: string;
    sessionId: string;
    reasons: string[];
  }>;
  confirmedExposures: Array<{
    servingId: string;
    studentAnonId: string;
    exposedConfirmed: string[];
    usageRowIds: string[];
  }>;
  assessments: AnalysisRun['assessments'];
  qualityIssueCounts: AnalysisRun['summary']['qualityIssueCounts'];
  disclaimer: string;
}

export function buildRunExport(run: AnalysisRun, exportedAt: string): RunExport {
  return {
    exportKind: 'allergen-coverage-run',
    exportedAt,
    runId: run.summary.runId,
    ruleVersion: run.summary.ruleVersion,
    mappingVersion: run.summary.mappingVersion,
    mappingRevision: run.summary.mappingRevision,
    inputFileHashes: run.summary.inputHashes,
    caliberSummary: {
      confirmed:
        '仅精确供应商编码、已批准别名或分析师人工确认的原料解析进入“有证据支持”统计',
      candidate: '名称/规格/单位/成分生成的候选必须经分析师确认后才生效，确认前不计入正式结果',
      unknown:
        '来源缺失、链接断裂、批次未到齐、时间无法归属等一律计入未知，不得表述为“确认无过敏原”',
      plannedExcluded: '厨房 status=PLANNED 的“计划使用”不参与实际暴露计算',
    },
    coverage: run.summary.coverage,
    metricDetails: run.metricDetails,
    unknownScope: run.assessments
      .filter((a) => a.bucket === 'UNKNOWN_MISSING')
      .map((a) => ({
        servingId: a.servingId,
        studentAnonId: a.studentAnonId,
        sessionId: a.sessionId,
        reasons: a.unknownReasons,
      })),
    confirmedExposures: run.assessments
      .filter((a) => a.bucket === 'CONFIRMED' && a.exposedConfirmed.length > 0)
      .map((a) => ({
        servingId: a.servingId,
        studentAnonId: a.studentAnonId,
        exposedConfirmed: a.exposedConfirmed,
        usageRowIds: a.usageRowIds,
      })),
    assessments: run.assessments,
    qualityIssueCounts: run.summary.qualityIssueCounts,
    disclaimer:
      '本文件中的“未知/无法判定”表示当前来源缺少证据，不等于该餐确认不含过敏原；接收方不得据此作出“无过敏原”结论。',
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, filename);
}

export function assessmentsToCsv(run: AnalysisRun): string {
  const header = [
    'serving_id',
    'student_anon_id',
    'session_id',
    'school_id',
    'served_at',
    'bucket',
    'allergens_confirmed',
    'restriction_allergens',
    'exposed_confirmed',
    'unknown_reasons',
    'usage_row_ids',
  ];
  const lines = [header.join(',')];
  run.assessments.forEach((a) => {
    lines.push(
      [
        a.servingId,
        a.studentAnonId,
        a.sessionId,
        a.schoolId,
        a.servedAt,
        BUCKET_LABEL[a.bucket],
        a.allergensConfirmed.join(';'),
        a.restrictionAllergens.join(';'),
        a.exposedConfirmed.join(';'),
        a.unknownReasons.join(';'),
        a.usageRowIds.join(';'),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
  });
  return '﻿' + lines.join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
}

// ---------- 供餐周期时间关联导出 ----------

export const CORRELATION_STATUS_LABEL: Record<CorrelationStatus, string> = {
  CONFIRMED: '已确认',
  CANDIDATE: '仍有候选',
  CONFLICT: '时间冲突',
  UNGROUNDED: '缺少依据',
};

/** 关联运行导出载荷：明细与统计引用同一次关联运行，版本固定 */
export interface CorrelationExport {
  exportKind: 'serving-period-correlation-run';
  exportedAt: string;
  runId: string;
  taskId: string;
  ruleVersion: string;
  timeSettingsVersion: string;
  calendarVersion: string;
  relationsVersion: string;
  mappingVersion: string;
  inputFileHashes: Record<string, string>;
  scope: CorrelationRun['summary']['scope'];
  counts: CorrelationRun['summary']['counts'];
  uniqueServings: number;
  duplicateServingReports: number;
  perPeriod: CorrelationRun['summary']['perPeriod'];
  periods: CorrelationRun['periods'];
  transfers: CorrelationRun['transfers'];
  events: CorrelationRun['events'];
  caliberNotes: string[];
  disclaimer: string;
}

export function buildCorrelationExport(run: CorrelationRun, exportedAt: string): CorrelationExport {
  return {
    exportKind: 'serving-period-correlation-run',
    exportedAt,
    runId: run.summary.runId,
    taskId: run.summary.taskId,
    ruleVersion: run.summary.ruleVersion,
    timeSettingsVersion: run.summary.timeSettingsVersion,
    calendarVersion: run.summary.calendarVersion,
    relationsVersion: run.summary.relationsVersion,
    mappingVersion: run.summary.mappingVersion,
    inputFileHashes: run.summary.inputHashes,
    scope: run.summary.scope,
    counts: run.summary.counts,
    uniqueServings: run.summary.uniqueServings,
    duplicateServingReports: run.summary.duplicateServingReports,
    perPeriod: run.summary.perPeriod,
    periods: run.periods,
    transfers: run.transfers,
    events: run.events,
    caliberNotes: [
      '已确认：有明确引用（批次/窗口/转供）且时间不矛盾；候选：仅时间邻近，未自动确认',
      '时间冲突：明确引用与时间矛盾，冲突保留并指出原始行，未抹掉引用改配',
      '缺少依据：无引用且无开放区间，或跨餐次使用缺少转供记录；不推断发生过或没有发生',
      '唯一发餐数按物理事件标识去重；真实两次发餐即使时间相同也分别计数',
    ],
    disclaimer:
      '本文件中的「缺少依据/仍有候选」表示当前来源缺少证据，不等于该餐次确认未使用该原料；接收方不得据此作出「未发生」结论。',
  };
}

export function correlationEventsToCsv(run: CorrelationRun): string {
  const header = [
    'event_key',
    'event_type',
    'ref_id',
    'school_id',
    'status',
    'period_ids',
    'raw_time',
    'precision',
    'normalized_earliest_ms',
    'normalized_latest_ms',
    'clock_correction',
    'received_at',
    'batch_id',
    'row_id',
    'window',
    'production_ref',
    'duplicate_of',
    'basis_note',
    'conflict_note',
  ];
  const lines = [header.join(',')];
  run.events.forEach((e) => {
    lines.push(
      [
        e.eventKey,
        e.eventType,
        e.refId,
        e.schoolId,
        CORRELATION_STATUS_LABEL[e.status],
        e.periodIds.join(';'),
        e.time.rawText,
        e.time.precision,
        String(e.time.earliestMs),
        String(e.time.latestMs),
        e.time.correction ? `${e.time.correction.segmentId}(${e.time.correction.offsetMinutes}min)` : '',
        e.receivedAt ?? '',
        e.batchId,
        e.rowId,
        e.window,
        e.productionRef,
        e.duplicateOf ?? '',
        e.basisNote,
        e.conflictNote ?? '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
  });
  return '﻿' + lines.join('\n');
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
