// 领域类型定义：所有分析结果均由输入数据 + 映射 + 规则版本派生

export type SourceType =
  | 'supplier_items'
  | 'recipes'
  | 'kitchen_usage'
  | 'meal_sessions'
  | 'meal_servings'
  | 'diet_restrictions'
  | 'material_issues'
  | 'production_batches'
  | 'serving_events';

export type BatchStatus = 'ARRIVED' | 'PENDING';

export interface BatchMeta {
  batchId: string;
  sourceType: SourceType;
  schoolId: string;
  fileName: string;
  dataDate: string;
  updatedAt: string | null;
  expectedRows: number;
  status: BatchStatus;
  notes?: string;
}

export interface Manifest {
  manifestVersion: string;
  generatedAt: string;
  mealWindows: MealWindow[];
  batches: BatchMeta[];
}

export interface MealWindow {
  schoolId: string;
  window: string;
  start: string;
  end: string;
}

/** 解析后的原始行：保留行号与原始字段，便于下钻 */
export interface RawRow {
  rowId: string; // batchId + '#' + 行号
  batchId: string;
  lineNo: number;
  values: Record<string, string>;
}

export interface LoadedBatch {
  meta: BatchMeta;
  headers: string[];
  rows: RawRow[];
  /** 输入文件内容哈希（运行固定引用，防止静默改写） */
  fileHash: string;
}

export interface StandardIngredient {
  stdId: string;
  name: string;
  category: string;
  allergens: string[];
  baseUnit: string;
}

export type MappingDecision = 'APPROVED_ALIAS' | 'CONFIRMED' | 'REJECTED' | 'CANDIDATE';

export interface SupplierMappingEntry {
  schoolId: string;
  supplierCode: string;
  stdId: string;
  decision: MappingDecision;
  note?: string;
}

export interface KitchenMappingEntry {
  schoolId: string;
  kitchenAlias: string;
  stdId: string;
  decision: MappingDecision;
  note?: string;
}

export interface StudentSessionMappingEntry {
  studentAnonId: string;
  sessionId: string;
  decision: MappingDecision;
  note?: string;
}

export interface MappingDocument {
  mappingVersion: string;
  ruleVersion: string;
  updatedAt: string;
  supplierMappings: SupplierMappingEntry[];
  kitchenMappings: KitchenMappingEntry[];
  studentSessionMappings: StudentSessionMappingEntry[];
}

/** 映射保存时的乐观锁包装 */
export interface MappingState {
  doc: MappingDocument;
  /** 单调递增版本号，保存冲突检测用 */
  revision: number;
  lastModifiedAt: string;
}

// ---------- 质量检查 ----------

export type QualityIssueType =
  | 'DUPLICATE_KEY'
  | 'MISSING_KEY'
  | 'UNIT_CONFLICT'
  | 'TIME_UNASSIGNABLE'
  | 'MANY_TO_MANY';

export interface QualityIssue {
  type: QualityIssueType;
  batchId: string;
  rowIds: string[];
  field: string;
  message: string;
  detail?: Record<string, string | number>;
}

/** 字段四态：源文件未提供 / 值为空 / 关联对象不存在 / 批次未到齐 */
export type FieldStatus =
  | 'FIELD_NOT_PROVIDED'
  | 'VALUE_EMPTY'
  | 'REF_NOT_FOUND'
  | 'BATCH_PENDING'
  | 'OK';

export interface FieldCheck {
  batchId: string;
  field: string;
  status: FieldStatus;
  count: number;
  rowIds: string[];
}

// ---------- 匹配与候选 ----------

export type MatchKind = 'EXACT_CODE' | 'APPROVED_ALIAS' | 'CONFIRMED' | 'CANDIDATE' | 'UNMATCHED';

export interface MatchCandidate {
  target: string; // 被匹配的键（供应商编码 / 厨房简称）
  stdId: string;
  score: number;
  reasons: string[];
}

export interface MatchResolution {
  scope: string; // schoolId 或 *
  sourceKey: string;
  kind: MatchKind;
  stdId: string | null;
  candidates: MatchCandidate[];
  evidenceRowIds: string[];
}

// ---------- 分析运行 ----------

export type EvidenceBucket = 'CONFIRMED' | 'CANDIDATE_PENDING' | 'UNKNOWN_MISSING';

export interface ServingAssessment {
  servingId: string;
  studentAnonId: string;
  sessionId: string;
  schoolId: string;
  servedAt: string;
  window: string;
  recipeId: string;
  bucket: EvidenceBucket;
  /** 实际参与计算的厨房用料行（仅 ACTUAL 且已解析到标准原料） */
  usageRowIds: string[];
  allergensConfirmed: string[];
  restrictionAllergens: string[];
  exposedConfirmed: string[];
  unknownReasons: string[];
  trace: TraceStep[];
}

export interface TraceStep {
  stage: string;
  decision: string;
  ref: string;
}

export interface CoverageCounts {
  total: number;
  confirmed: number;
  candidatePending: number;
  unknownMissing: number;
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  inputHashes: Record<string, string>;
  mappingVersion: string;
  mappingRevision: number;
  ruleVersion: string;
  scopeBatchIds: string[];
  coverage: CoverageCounts;
  confirmedExposures: number;
  confirmedSafe: number;
  unknownReasonsBreakdown: Record<string, number>;
  qualityIssueCounts: Record<QualityIssueType, number>;
}

export interface AnalysisRun {
  summary: RunSummary;
  assessments: ServingAssessment[];
  qualityIssues: QualityIssue[];
  fieldChecks: FieldCheck[];
  resolutions: MatchResolution[];
  metricDetails: MetricDetail[];
}

export interface MetricDetail {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  exclusions: string[];
  sourceScope: string[];
  explanation: string;
}

export interface RunDiff {
  baseRunId: string;
  targetRunId: string;
  changedServingBuckets: Record<EvidenceBucket, Record<EvidenceBucket, number>>;
  coverageBefore: CoverageCounts;
  coverageAfter: CoverageCounts;
  changedServingIds: string[];
  newIssues: QualityIssue[];
  resolvedIssues: QualityIssue[];
}

// ---------- 供餐周期与多源事件时间关联 ----------

/** 时间精度：仅日期 / 分钟 / 秒 / 带明确偏移的完整时间戳，分别处理，不互相补齐 */
export type TimePrecision = 'date' | 'minute' | 'second' | 'instant';

/** 时间字段的业务含义：供应商文件日期只是资料生成日期，不能当作事件发生时间 */
export type TimeFieldMeaning =
  | 'ISSUE_TIME'
  | 'PRODUCTION_START'
  | 'PRODUCTION_FINISH'
  | 'SERVING_TIME'
  | 'FILE_GENERATED_AT';

/** 有凭证的校时区段：一次校时作用于同一设备整段记录，跨设备不共用 */
export interface ClockCorrectionSegment {
  segmentId: string;
  device: string;
  validFrom: string; // ISO 带偏移
  validTo: string;
  /** 记录时间 + offset = 实际时间（终端快 5 分钟则 offset = -5） */
  offsetMinutes: number;
  evidence: string;
}

export interface TimeFieldProfile {
  field: string;
  meaning: TimeFieldMeaning;
  precision: TimePrecision;
  /** 显式声明的时区偏移（如 "+08:00"）；null = 未声明，按学校当地时区解释，不借用浏览器设置 */
  timezone: string | null;
}

export interface SourceTimeProfile {
  sourceId: string;
  label: string;
  appliesTo: { sourceTypes: SourceType[]; schoolId: string };
  fields: TimeFieldProfile[];
  clockCorrections: ClockCorrectionSegment[];
}

export interface TimeSettingsDocument {
  settingsVersion: string;
  updatedAt: string;
  /** 学校当地时区（固定偏移，如 "+08:00"），供餐周期按学校当地日历及业务日归属 */
  schoolTimezones: Record<string, string>;
  sources: SourceTimeProfile[];
}

export interface PeriodAdjustment {
  type: 'EXTEND' | 'SPECIAL_OPEN';
  note: string;
  approvedBy: string;
  originalCloseAt?: string;
  recordedAt: string;
}

/** 供餐日历：学校 + 窗口 + 餐别 + 业务日 + 实际开放区间（可跨午夜）+ 临时调整 */
export interface ServingPeriod {
  periodId: string;
  schoolId: string;
  window: string;
  mealType: string;
  businessDay: string; // 学校当地业务日 YYYY-MM-DD
  openAt: string; // ISO 带偏移（学校当地）
  closeAt: string; // 可晚于 openAt 的自然日（跨午夜）
  adjustment?: PeriodAdjustment;
}

export interface ServingCalendarDocument {
  calendarVersion: string;
  updatedAt: string;
  periods: ServingPeriod[];
}

/** 转供记录：剩余制成品跨餐次使用的唯一依据（保质期/在库状态不能代替） */
export interface TransferRecord {
  transferId: string;
  productionRef: string;
  toSchoolId: string;
  toWindow: string;
  toBusinessDay: string;
  note: string;
  evidence: string;
  recordedAt: string;
}

/** 批次关系：领料→制作、制作→发餐的明确引用在事件行内，此处保存可补录的转供记录 */
export interface BatchRelationsDocument {
  relationsVersion: string;
  updatedAt: string;
  transfers: TransferRecord[];
}

/** 版本化文档包装（时间设置 / 日历 / 批次关系各自独立维护，修订号单调递增） */
export interface VersionedDocument<T> {
  doc: T;
  revision: number;
  lastModifiedAt: string;
}

/** 标准化后的时间：保留原始文本、精度、时区解释与所用校时依据 */
export interface NormalizedTime {
  rawText: string;
  precision: TimePrecision;
  /** 半开区间 [earliestMs, latestMs)：date=全天，minute=该分钟，second=该秒，instant=瞬时 */
  earliestMs: number;
  latestMs: number;
  timezoneNote: string;
  correction: { segmentId: string; offsetMinutes: number; evidence: string } | null;
}

export type CorrelationStatus = 'CONFIRMED' | 'CANDIDATE' | 'CONFLICT' | 'UNGROUNDED';

export type CorrelationEventType = 'ISSUE' | 'PRODUCTION' | 'SERVING';

export interface CandidatePeriod {
  periodId: string;
  excluded: boolean;
  reason: string;
}

/** 一条来源事件的关联结果：原始时间文本、标准化范围、校时依据、收到时间均可查 */
export interface CorrelatedEvent {
  eventKey: string;
  eventType: CorrelationEventType;
  /** 业务标识（issue_id / production_id / event_id） */
  refId: string;
  rowId: string;
  batchId: string;
  receivedAt: string | null;
  schoolId: string;
  device: string;
  label: string;
  time: NormalizedTime;
  timeEnd?: NormalizedTime;
  window: string;
  servingUid: string;
  productionRef: string;
  issueRefs: string[];
  status: CorrelationStatus;
  periodIds: string[];
  candidates: CandidatePeriod[];
  referenceChain: string[];
  basisNote: string;
  conflictNote?: string;
  relatedRowIds: string[];
  /** 重复上报：指向同一物理发餐事件的首次记录 */
  duplicateOf?: string;
}

export interface CorrelationScope {
  schoolIds: string[];
  businessDays: string[];
}

export interface PeriodStatusCounts {
  periodId: string;
  confirmed: number;
  candidate: number;
  conflict: number;
  ungrounded: number;
}

export interface CorrelationRunSummary {
  runId: string;
  taskId: string;
  createdAt: string;
  ruleVersion: string;
  timeSettingsVersion: string;
  timeSettingsRevision: number;
  calendarVersion: string;
  calendarRevision: number;
  relationsVersion: string;
  relationsRevision: number;
  mappingVersion: string;
  mappingRevision: number;
  inputHashes: Record<string, string>;
  scope: CorrelationScope;
  counts: Record<CorrelationStatus, number>;
  /** 唯一发餐事件数（同一物理事件被多来源重复记载只计一次） */
  uniqueServings: number;
  duplicateServingReports: number;
  perPeriod: PeriodStatusCounts[];
}

/** 关联运行：不可变，固定引用时间解释、日历与资料批次版本 */
export interface CorrelationRun {
  summary: CorrelationRunSummary;
  events: CorrelatedEvent[];
  periods: ServingPeriod[];
  transfers: TransferRecord[];
}

export type CorrelationTaskStatus = 'RUNNING' | 'CANCELLED' | 'DONE' | 'INTERRUPTED' | 'FAILED';

/** 关联任务：进度可查、可取消、刷新后可恢复状态；代际号防止旧任务覆盖新范围 */
export interface CorrelationTask {
  taskId: string;
  label: string;
  scope: CorrelationScope;
  status: CorrelationTaskStatus;
  progress: { done: number; total: number; stage: string };
  createdAt: string;
  finishedAt?: string;
  resultRunId?: string;
  generation: number;
  error?: string;
}

/** 更正影响预览：同时检查原时间位置与更正后位置 */
export interface CorrelationImpact {
  kind: 'calendar' | 'timeSettings' | 'relations';
  changed: Array<{
    eventKey: string;
    label: string;
    before: { status: CorrelationStatus; periodIds: string[] };
    after: { status: CorrelationStatus; periodIds: string[] };
  }>;
  /** 受影响餐次：原归属与新归属两侧都列出 */
  affectedPeriods: Array<{
    periodId: string;
    before: PeriodStatusCounts;
    after: PeriodStatusCounts;
  }>;
  /** 此前没有任何候选、更正后首次进入范围的记录（日历修订必须检查） */
  newlyCandidate: string[];
  beforeCounts: Record<CorrelationStatus, number>;
  afterCounts: Record<CorrelationStatus, number>;
}
