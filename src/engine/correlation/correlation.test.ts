import { describe, expect, it } from 'vitest';
import { loadTestDataset } from '../../test/loadTestDataset';
import {
  correlateSync,
  correlateRowByRow,
  CORRELATION_RULE_VERSION,
  type CorrelationInput,
} from './correlate';
import { previewCorrelationImpact } from './impact';
import {
  detectPrecision,
  formatMs,
  normalizeTime,
  parseOffsetMinutes,
} from './timeNorm';
import type {
  BatchRelationsDocument,
  ServingCalendarDocument,
  TimeSettingsDocument,
} from '../../types';

const dataset = await loadTestDataset();

function makeInput(overrides?: {
  timeSettings?: TimeSettingsDocument;
  calendar?: ServingCalendarDocument;
  relations?: BatchRelationsDocument;
}): CorrelationInput {
  return {
    dataset,
    timeSettings: overrides?.timeSettings ?? dataset.timeSettingsSeed,
    calendar: overrides?.calendar ?? dataset.calendarSeed,
    relations: overrides?.relations ?? dataset.relationsSeed,
    runId: 'CRUN-TEST',
    taskId: 'TASK-TEST',
    createdAt: '2026-09-06T10:00:00.000Z',
    mappingVersion: dataset.seedMapping.mappingVersion,
    mappingRevision: 1,
    revisions: { timeSettings: 1, calendar: 1, relations: 1 },
  };
}

const baseRun = correlateSync(makeInput());
const byKey = new Map(baseRun.events.map((e) => [e.eventKey, e]));
const ev = (key: string) => byKey.get(key)!;

// 日历修订：记录 9/4 夜宵临时延长至次日 00:40（跨午夜）
const extendedCalendar: ServingCalendarDocument = {
  ...dataset.calendarSeed,
  calendarVersion: 'cal-v2',
  periods: dataset.calendarSeed.periods.map((p) =>
    p.periodId === 'P-A-0904-N'
      ? {
          ...p,
          closeAt: '2026-09-05T00:40:00+08:00',
          adjustment: {
            type: 'EXTEND',
            note: '考试周夜宵延长至 00:40',
            approvedBy: '后勤处',
            originalCloseAt: '2026-09-05T00:00:00+08:00',
            recordedAt: '2026-09-05T10:00:00+08:00',
          },
        }
      : p,
  ),
};

// 时间解释更正：补录 WT-A-2 终端 +8 分钟的校时区段（有凭证）
const correctedSettings: TimeSettingsDocument = {
  ...dataset.timeSettingsSeed,
  settingsVersion: 'ts-v2',
  sources: dataset.timeSettingsSeed.sources.map((s) =>
    s.sourceId === 'window-log'
      ? {
          ...s,
          clockCorrections: [
            ...s.clockCorrections,
            {
              segmentId: 'CC-WTA2-0904',
              device: 'WT-A-2',
              validFrom: '2026-09-04T00:00:00+08:00',
              validTo: '2026-09-06T23:59:59+08:00',
              offsetMinutes: -8,
              evidence: '维修单 WX-20260906-01：WT-A-2 终端时钟偏快 8 分钟',
            },
          ],
        }
      : s,
  ),
};

// 补录转供记录：PB-A-0402 剩余制成品转供 9/5 午餐
const supplementedRelations: BatchRelationsDocument = {
  ...dataset.relationsSeed,
  relationsVersion: 'rel-v2',
  transfers: [
    ...dataset.relationsSeed.transfers,
    {
      transferId: 'TR-A-02',
      productionRef: 'PB-A-0402',
      toSchoolId: 'A',
      toWindow: 'lunch',
      toBusinessDay: '2026-09-05',
      note: '番茄炒蛋剩余制成品转供次日午餐',
      evidence: '留样记录 LY-0905-02 + 转供单 ZG-0905-01',
      recordedAt: '2026-09-06T09:00:00+08:00',
    },
  ],
};

const extendedInput = makeInput({ calendar: extendedCalendar });
const correctedInput = makeInput({ calendar: extendedCalendar, timeSettings: correctedSettings });
const supplementedInput = makeInput({
  calendar: extendedCalendar,
  timeSettings: correctedSettings,
  relations: supplementedRelations,
});

describe('时间规范化：精度分级处理', () => {
  it('只写日期的记录规范化为全天区间，不补成午夜整点', () => {
    const r = normalizeTime('2026-09-04', {
      schoolOffsetMinutes: 480,
      declaredTimezone: null,
      corrections: [],
      device: 'X',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.time.precision).toBe('date');
    // 全天半开区间 [00:00, 次日00:00)，不是 00:00 瞬时
    expect(r.time.latestMs - r.time.earliestMs).toBe(86_400_000);
    expect(formatMs(r.time.earliestMs, 480)).toBe('2026-09-04 00:00');
    expect(formatMs(r.time.latestMs, 480)).toBe('2026-09-05 00:00');
  });

  it('分钟精度展开为一分钟区间，完整时间戳按自带偏移使用不再换算', () => {
    const minute = normalizeTime('2026-09-04 23:40', {
      schoolOffsetMinutes: 480,
      declaredTimezone: null,
      corrections: [],
      device: 'X',
    });
    expect(minute.ok && minute.time.latestMs - minute.time.earliestMs).toBe(60_000);

    const instant = normalizeTime('2026-09-01T07:50:00+08:00', {
      schoolOffsetMinutes: 480,
      declaredTimezone: null,
      corrections: [],
      device: 'X',
    });
    expect(instant.ok).toBe(true);
    if (!instant.ok) return;
    expect(instant.time.precision).toBe('instant');
    expect(instant.time.earliestMs).toBe(Date.parse('2026-09-01T07:50:00+08:00'));
    expect(instant.time.timezoneNote).toContain('不再换算');
  });

  it('未声明时区的本地时间按学校时区解释，不借用浏览器设置', () => {
    const r = normalizeTime('2026-09-04 23:40', {
      schoolOffsetMinutes: 480,
      declaredTimezone: null,
      corrections: [],
      device: 'X',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 与浏览器时区无关：直接等于 +08:00 下的确定值
    expect(r.time.earliestMs).toBe(Date.parse('2026-09-04T23:40:00+08:00'));
    expect(r.time.timezoneNote).toContain('学校当地时区');
  });

  it('精度识别与偏移解析', () => {
    expect(detectPrecision('2026-09-04')).toBe('date');
    expect(detectPrecision('2026-09-04 23:40')).toBe('minute');
    expect(detectPrecision('2026-09-04T23:40:15')).toBe('second');
    expect(detectPrecision('2026-09-04T23:40:15+08:00')).toBe('instant');
    expect(parseOffsetMinutes('+08:00')).toBe(480);
    expect(parseOffsetMinutes('-0530')).toBe(-330);
  });
});

describe('校时区段：整段生效、跨设备不共用', () => {
  const segs = dataset.timeSettingsSeed.sources[0].clockCorrections;

  it('同一区段的全部记录共用同一偏差，不逐行挑选', () => {
    const a = normalizeTime('2026-09-04 23:40', {
      schoolOffsetMinutes: 480,
      declaredTimezone: null,
      corrections: segs,
      device: 'KT-A-1',
    });
    const b = normalizeTime('2026-09-05 05:20', {
      schoolOffsetMinutes: 480,
      declaredTimezone: null,
      corrections: segs,
      device: 'KT-A-1',
    });
    expect(a.ok && a.time.correction?.segmentId).toBe('CC-KTA1-0901');
    expect(b.ok && b.time.correction?.segmentId).toBe('CC-KTA1-0901');
    expect(a.ok && a.time.correction?.offsetMinutes).toBe(-5);
    expect(b.ok && b.time.correction?.offsetMinutes).toBe(-5);
  });

  it('其他设备不能共用该偏差', () => {
    const r = normalizeTime('2026-09-04 16:05', {
      schoolOffsetMinutes: 480,
      declaredTimezone: null,
      corrections: segs,
      device: 'KT-A-2',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.time.correction).toBeNull();
    expect(r.time.earliestMs).toBe(Date.parse('2026-09-04T16:05:00+08:00'));
  });
});

describe('供餐周期关联（种子状态）', () => {
  it('午夜前领料次日发餐：ISS-A-01 经明确引用归属 9/5 早餐', () => {
    const e = ev('ISSUE:ISS-A-01');
    expect(e.status).toBe('CONFIRMED');
    expect(e.periodIds).toEqual(['P-A-0905-B']);
    // 校时依据可查：KT-A-1 整段 -5 分钟
    expect(e.time.correction?.segmentId).toBe('CC-KTA1-0901');
    expect(e.time.rawText).toBe('2026-09-04 23:40');
  });

  it('不同时间精度：ISS-A-03 仅日期，按全天区间处理且仍可确认引用', () => {
    const e = ev('ISSUE:ISS-A-03');
    expect(e.time.precision).toBe('date');
    expect(e.time.latestMs - e.time.earliestMs).toBe(86_400_000);
    expect(e.status).toBe('CONFIRMED');
    expect(e.periodIds).toEqual(['P-A-0904-D']);
  });

  it('无引用的时间邻近：ISS-A-04 只给候选不自动确认', () => {
    const e = ev('ISSUE:ISS-A-04');
    expect(e.status).toBe('CANDIDATE');
    expect(e.basisNote).toContain('时间邻近不证明实际投料');
    expect(e.periodIds.length).toBeGreaterThan(0);
  });

  it('同批次跨餐转供：PB-A-0401 保留晚餐+夜宵实际分流关系', () => {
    const e = ev('PRODUCTION:PB-A-0401');
    expect(e.status).toBe('CONFIRMED');
    expect(e.periodIds).toEqual(['P-A-0904-D', 'P-A-0904-N']);
    // 夜宵发餐凭转供记录确认
    const se2 = ev('SERVING:SE-A-002');
    expect(se2.status).toBe('CONFIRMED');
    expect(se2.periodIds).toEqual(['P-A-0904-N']);
    expect(se2.basisNote).toContain('TR-A-01');
  });

  it('延长夜宵未记录时：SE-A-003 明确引用与时间矛盾，保留冲突并指出原始行', () => {
    const e = ev('SERVING:SE-A-003');
    expect(e.status).toBe('CONFLICT');
    expect(e.conflictNote).toContain('引用链');
    expect(e.relatedRowIds).toContain('sev-1#L4');
    expect(e.relatedRowIds.some((r) => r.startsWith('prd-a-1'))).toBe(true);
  });

  it('重复上报只计一次；真实的两次发餐即使时间相同也不合并', () => {
    const dup = ev('SERVING:SE-A-005');
    expect(dup.duplicateOf).toBe('SERVING:SE-A-004');
    const real = ev('SERVING:SE-A-006');
    expect(real.duplicateOf).toBeUndefined();
    expect(real.status).toBe('CONFIRMED');
    expect(baseRun.summary.uniqueServings).toBe(14);
    expect(baseRun.summary.duplicateServingReports).toBe(1);
  });

  it('跨餐次剩余制成品缺少转供依据：SE-A-007 保留未知，不推断', () => {
    const e = ev('SERVING:SE-A-007');
    expect(e.status).toBe('UNGROUNDED');
    expect(e.basisNote).toContain('缺少转供记录');
    expect(e.periodIds).toEqual([]);
  });

  it('制作完成晚于发餐：SE-A-009 时间冲突', () => {
    const e = ev('SERVING:SE-A-009');
    expect(e.status).toBe('CONFLICT');
    expect(e.conflictNote).toContain('完成');
  });

  it('无引用发餐：SE-A-010 候选不自动确认；SE-A-011/013 暂无开放区间', () => {
    expect(ev('SERVING:SE-A-010').status).toBe('CANDIDATE');
    expect(ev('SERVING:SE-A-010').periodIds).toEqual(['P-A-0904-N']);
    expect(ev('SERVING:SE-A-011').status).toBe('UNGROUNDED');
    expect(ev('SERVING:SE-A-013').status).toBe('UNGROUNDED');
  });

  it('日期精度发餐误差跨边界：SE-A-012 保留所有仍成立的候选', () => {
    const e = ev('SERVING:SE-A-012');
    expect(e.status).toBe('CANDIDATE');
    expect(e.periodIds).toEqual(['P-A-0905-B', 'P-A-0905-D', 'P-A-0905-L']);
  });

  it('两个窗口同时开放：SE-B-001 保留两个候选，不裁掉真实窗口', () => {
    const e = ev('SERVING:SE-B-001');
    expect(e.status).toBe('CANDIDATE');
    expect(e.periodIds).toEqual(['P-B-0905-B', 'P-B-0905-BX']);
  });

  it('明确引用可消除重叠窗口歧义：SE-B-002 确认到快餐窗口', () => {
    const e = ev('SERVING:SE-B-002');
    expect(e.status).toBe('CONFIRMED');
    expect(e.periodIds).toEqual(['P-B-0905-BX']);
  });

  it('运行固定引用时间解释/日历/批次关系版本与规则版本', () => {
    expect(baseRun.summary.ruleVersion).toBe(CORRELATION_RULE_VERSION);
    expect(baseRun.summary.timeSettingsVersion).toBe('ts-v1');
    expect(baseRun.summary.calendarVersion).toBe('cal-v1');
    expect(baseRun.summary.relationsVersion).toBe('rel-v1');
    expect(Object.keys(baseRun.summary.inputHashes).length).toBeGreaterThan(0);
  });
});

describe('日历修订：延长夜宵跨午夜', () => {
  const run = correlateSync(extendedInput);
  const get = (k: string) => run.events.find((e) => e.eventKey === k)!;

  it('SE-A-003 冲突消解为已确认，仍属 9/4 业务日夜宵（不按午夜机械切割）', () => {
    const e = get('SERVING:SE-A-003');
    expect(e.status).toBe('CONFIRMED');
    expect(e.periodIds).toEqual(['P-A-0904-N']);
  });

  it('SE-A-011 此前无候选，修订后首次进入范围', () => {
    const e = get('SERVING:SE-A-011');
    expect(e.status).toBe('CANDIDATE');
    expect(e.periodIds).toEqual(['P-A-0904-N']);
  });

  it('SE-A-012 日期精度候选增加跨午夜夜宵，仍保留全部候选', () => {
    const e = get('SERVING:SE-A-012');
    expect(e.periodIds).toEqual(['P-A-0904-N', 'P-A-0905-B', 'P-A-0905-D', 'P-A-0905-L']);
  });

  it('影响预览同时检查原位置与新位置，并列出首次获得候选的记录', () => {
    const impact = previewCorrelationImpact('calendar', makeInput(), extendedInput);
    expect(impact.newlyCandidate).toContain('SERVING:SE-A-011');
    const night = impact.affectedPeriods.find((p) => p.periodId === 'P-A-0904-N');
    expect(night).toBeDefined();
    // 原位置与新位置两侧计数都给出
    expect(night!.after.confirmed).toBeGreaterThan(night!.before.confirmed);
    const moved = impact.changed.find((c) => c.eventKey === 'SERVING:SE-A-003');
    expect(moved?.before.status).toBe('CONFLICT');
    expect(moved?.after.status).toBe('CONFIRMED');
  });
});

describe('更正时间解释：补录校时区段', () => {
  const run = correlateSync(correctedInput);
  const get = (k: string) => run.events.find((e) => e.eventKey === k)!;

  it('SE-A-013 校时后首次进入范围（00:45 → 00:37 落入延长夜宵）', () => {
    const e = get('SERVING:SE-A-013');
    expect(e.status).toBe('CANDIDATE');
    expect(e.periodIds).toEqual(['P-A-0904-N']);
    expect(e.time.correction?.segmentId).toBe('CC-WTA2-0904');
    expect(e.time.correction?.offsetMinutes).toBe(-8);
  });

  it('同一设备的其他记录共用该区段校时（SE-A-010：23:20 → 23:12）', () => {
    const e = get('SERVING:SE-A-010');
    expect(e.time.correction?.segmentId).toBe('CC-WTA2-0904');
    expect(e.status).toBe('CANDIDATE');
  });

  it('其他设备的记录不受该校时影响', () => {
    const e = get('SERVING:SE-A-001');
    expect(e.time.correction).toBeNull();
  });
});

describe('补录转供记录：跨周期迁移', () => {
  const run = correlateSync(supplementedInput);
  const get = (k: string) => run.events.find((e) => e.eventKey === k)!;

  it('SE-A-007 由缺少依据迁移为已确认，归属 9/5 午餐', () => {
    const e = get('SERVING:SE-A-007');
    expect(e.status).toBe('CONFIRMED');
    expect(e.periodIds).toEqual(['P-A-0905-L']);
    expect(e.basisNote).toContain('TR-A-02');
  });

  it('制作批次 PB-A-0402 保留晚餐+次日午餐分流关系', () => {
    const e = get('PRODUCTION:PB-A-0402');
    expect(e.periodIds).toEqual(['P-A-0904-D', 'P-A-0905-L']);
  });

  it('影响预览：原位置（未知范围）与新位置（9/5 午餐）两侧计数都更新', () => {
    const impact = previewCorrelationImpact(
      'relations',
      makeInput({ calendar: extendedCalendar, timeSettings: correctedSettings }),
      supplementedInput,
    );
    const moved = impact.changed.find((c) => c.eventKey === 'SERVING:SE-A-007');
    expect(moved?.before.status).toBe('UNGROUNDED');
    expect(moved?.after.status).toBe('CONFIRMED');
    const lunch = impact.affectedPeriods.find((p) => p.periodId === 'P-A-0905-L');
    expect(lunch).toBeDefined();
    expect(lunch!.after.confirmed).toBeGreaterThan(lunch!.before.confirmed);
    expect(impact.afterCounts.UNGROUNDED).toBeLessThan(impact.beforeCounts.UNGROUNDED);
  });
});

describe('批处理与逐条对照：两条路径结果一致', () => {
  it.each([
    ['种子状态', makeInput()],
    ['日历修订后', extendedInput],
    ['校时更正后', correctedInput],
    ['补录转供后', supplementedInput],
  ])('%s：排序扫描 ≡ 逐条计算，不漏跨日/跨窗口关联', (_label, input) => {
    const batch = correlateSync(input, 'sweep');
    const control = correlateRowByRow(input);
    expect(control.events).toEqual(batch.events);
    expect(control.summary.counts).toEqual(batch.summary.counts);
    expect(control.summary.uniqueServings).toBe(batch.summary.uniqueServings);
    expect(control.summary.perPeriod).toEqual(batch.summary.perPeriod);
  });
});
