// 时间规范化：日期 / 分钟 / 秒 / 带偏移的完整时间戳分别处理
// - 只写日期的记录规范化为全天半开区间，不补成午夜整点
// - 未声明时区的本地时间按学校当地时区解释，不借用浏览器设置
// - 带明确偏移的时间按原偏移使用，不再重复换算
// - 校时区段作用于同一设备的整段记录，跨设备不共用同一偏差

import type { ClockCorrectionSegment, NormalizedTime, TimePrecision } from '../../types';

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** "+08:00" / "-0530" / "Z" → 偏移分钟数 */
export function parseOffsetMinutes(tz: string): number | null {
  const s = tz.trim();
  if (s === 'Z' || s === 'UTC' || s === '+00:00' || s === '+0000') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return null;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -v : v;
}

export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** 从原始文本识别精度；无法识别返回 null */
export function detectPrecision(raw: string): TimePrecision | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(s)) return 'minute';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    return /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? 'instant' : 'second';
  }
  return null;
}

interface NaiveParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function parseNaive(s: string): NaiveParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s.trim());
  if (!m) return null;
  return {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4] ?? 0),
    mi: Number(m[5] ?? 0),
    s: Number(m[6] ?? 0),
  };
}

/** 本地墙钟时间 + 固定偏移 → epoch ms（不经过浏览器时区） */
export function naiveToMs(p: NaiveParts, offsetMinutes: number): number {
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - offsetMinutes * MINUTE_MS;
}

/** epoch ms → 指定偏移下的墙钟显示（统一显示时区，不改变归属） */
export function formatMs(ms: number, offsetMinutes: number, withSeconds = false): string {
  const d = new Date(ms + offsetMinutes * MINUTE_MS);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const sec = withSeconds ? `:${String(d.getUTCSeconds()).padStart(2, '0')}` : '';
  return `${date} ${time}${sec}`;
}

export function formatRange(t: NormalizedTime, offsetMinutes: number): string {
  if (t.precision === 'instant') return formatMs(t.earliestMs, offsetMinutes, true);
  if (t.precision === 'date') {
    const day = formatMs(t.earliestMs, offsetMinutes).slice(0, 10);
    return `${day} 全天`;
  }
  const end = t.latestMs - MINUTE_MS;
  return `${formatMs(t.earliestMs, offsetMinutes)} – ${formatMs(end, offsetMinutes).slice(11)}`;
}

export interface NormalizeOptions {
  /** 学校当地时区偏移（分钟），用于未声明时区的本地时间 */
  schoolOffsetMinutes: number;
  /** 字段声明的时区（null = 未声明）；原始文本自带偏移时以文本为准且不再换算 */
  declaredTimezone: string | null;
  /** 该来源全部校时区段（按设备匹配，整段生效） */
  corrections: ClockCorrectionSegment[];
  device: string;
}

export type NormalizeResult = { ok: true; time: NormalizedTime } | { ok: false; error: string };

/**
 * 规范化一条原始时间文本：
 * 1. 按文本识别精度（date/minute/second/instant）
 * 2. 文本自带偏移 → 按自带偏移（instant）；否则用字段声明时区；都未声明 → 学校当地时区
 * 3. 按设备匹配校时区段（记录时间落在区段内才生效），整段同一偏差
 */
export function normalizeTime(rawText: string, opts: NormalizeOptions): NormalizeResult {
  const raw = rawText.trim();
  if (!raw) return { ok: false, error: '时间字段为空' };
  const precision = detectPrecision(raw);
  if (!precision) return { ok: false, error: `无法识别的时间格式：${raw}` };

  const explicitOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) && precision === 'instant'
    ? parseOffsetMinutes(raw.match(/(Z|[+-]\d{2}:?\d{2})$/)![1])
    : null;

  let offsetMinutes: number;
  let timezoneNote: string;
  if (explicitOffset !== null) {
    offsetMinutes = explicitOffset;
    timezoneNote = `原始文本自带偏移 ${formatOffset(explicitOffset)}，按原值使用、不再换算`;
  } else if (opts.declaredTimezone) {
    const declared = parseOffsetMinutes(opts.declaredTimezone);
    if (declared === null) return { ok: false, error: `字段声明时区无法解析：${opts.declaredTimezone}` };
    offsetMinutes = declared;
    timezoneNote = `按来源声明时区 ${formatOffset(declared)} 解释`;
  } else {
    offsetMinutes = opts.schoolOffsetMinutes;
    timezoneNote = `未声明时区，按学校当地时区 ${formatOffset(opts.schoolOffsetMinutes)} 解释（不借用浏览器设置）`;
  }

  const parts = parseNaive(raw);
  if (!parts) return { ok: false, error: `无法解析的时间：${raw}` };
  const base = naiveToMs(parts, offsetMinutes);

  let earliestMs: number;
  let latestMs: number;
  if (precision === 'date') {
    earliestMs = base;
    latestMs = base + DAY_MS;
  } else if (precision === 'minute') {
    earliestMs = base;
    latestMs = base + MINUTE_MS;
  } else if (precision === 'second') {
    earliestMs = base;
    latestMs = base + 1000;
  } else {
    earliestMs = base;
    latestMs = base;
  }

  // 校时：记录时间落在区段内才应用；同一区段同一偏差，不为每行挑不同偏差
  let correction: NormalizedTime['correction'] = null;
  const seg = opts.corrections.find((c) => {
    if (c.device !== opts.device) return false;
    const from = Date.parse(c.validFrom);
    const to = Date.parse(c.validTo);
    return Number.isFinite(from) && Number.isFinite(to) && earliestMs >= from && earliestMs <= to;
  });
  if (seg && seg.offsetMinutes !== 0) {
    const shift = seg.offsetMinutes * MINUTE_MS;
    earliestMs += shift;
    latestMs += shift;
    correction = { segmentId: seg.segmentId, offsetMinutes: seg.offsetMinutes, evidence: seg.evidence };
  }

  return {
    ok: true,
    time: { rawText: raw, precision, earliestMs, latestMs, timezoneNote, correction },
  };
}

/** 两个半开区间是否重叠 */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
