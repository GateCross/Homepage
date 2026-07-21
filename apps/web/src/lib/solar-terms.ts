/**
 * 二十四节气（公历近似，覆盖 1900–2100）。
 * 以 1900-01-06 02:05 UTC 小寒为基准，按回归年偏移推算交节时刻。
 */

const TERM_NAMES = [
  "小寒",
  "大寒",
  "立春",
  "雨水",
  "惊蛰",
  "春分",
  "清明",
  "谷雨",
  "立夏",
  "小满",
  "芒种",
  "夏至",
  "小暑",
  "大暑",
  "立秋",
  "处暑",
  "白露",
  "秋分",
  "寒露",
  "霜降",
  "立冬",
  "小雪",
  "大雪",
  "冬至",
] as const;

/** 相对 1900 小寒的分钟偏移（经典农历表） */
const TERM_OFFSET_MINUTES = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072,
  240693, 263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795,
  462224, 483532, 504758,
] as const;

/** 1900-01-06 02:05:00 UTC */
const BASE_UTC_MS = Date.UTC(1900, 0, 6, 2, 5);

/** 回归年毫秒（365.2422 日） */
const TROPICAL_YEAR_MS = 31_556_925_974.7;

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

export type SolarTermName = (typeof TERM_NAMES)[number];

export type SolarTermOccurrence = {
  /** 0–23，小寒=0 … 冬至=23 */
  index: number;
  name: SolarTermName;
  /** 交节瞬间（UTC 毫秒） */
  atMs: number;
  year: number;
  month: number;
  day: number;
};

export function isSolarTermName(value: string): value is SolarTermName {
  return (TERM_NAMES as readonly string[]).includes(value);
}

/** 指定公历年的第 n 个节气交节时刻（n: 0=小寒 … 23=冬至）。 */
export function solarTermInstantMs(year: number, index: number): number | null {
  if (
    !Number.isInteger(year) ||
    year < MIN_YEAR ||
    year > MAX_YEAR ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 23
  ) {
    return null;
  }
  const offsetMin = TERM_OFFSET_MINUTES[index]!;
  return (
    BASE_UTC_MS +
    TROPICAL_YEAR_MS * (year - MIN_YEAR) +
    offsetMin * 60_000
  );
}

function ymdInTimeZone(
  ms: number,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(ms));
    const map = new Map(parts.map((p) => [p.type, p.value]));
    const year = Number(map.get("year"));
    const month = Number(map.get("month"));
    const day = Number(map.get("day"));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    return { year, month, day };
  } catch {
    return null;
  }
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 指定公历年、指定时区下全部 24 节气的本地日历日。 */
export function solarTermsForYear(
  year: number,
  timeZone: string = "UTC",
): SolarTermOccurrence[] {
  const out: SolarTermOccurrence[] = [];
  for (let i = 0; i < 24; i += 1) {
    const atMs = solarTermInstantMs(year, i);
    if (atMs === null) {
      continue;
    }
    const ymd = ymdInTimeZone(atMs, timeZone);
    if (ymd === null) {
      continue;
    }
    out.push({
      index: i,
      name: TERM_NAMES[i]!,
      atMs,
      year: ymd.year,
      month: ymd.month,
      day: ymd.day,
    });
  }
  return out;
}

export type CurrentSolarTerm = {
  name: SolarTermName;
  /** 该节气交节的本地日历日 */
  since: { year: number; month: number; day: number };
};

/**
 * 给定时区下「当前所处」节气：最近一次交节（含当日）的名称。
 * 冬至后至次年小寒前仍属冬至。
 */
export function currentSolarTerm(
  date: Date,
  timeZone: string,
): CurrentSolarTerm | null {
  const ymd = ymdInTimeZone(date.getTime(), timeZone);
  if (ymd === null) {
    return null;
  }
  const key = dateKey(ymd.year, ymd.month, ymd.day);

  const candidates = [
    ...solarTermsForYear(ymd.year - 1, timeZone),
    ...solarTermsForYear(ymd.year, timeZone),
    ...solarTermsForYear(ymd.year + 1, timeZone),
  ];

  let best: SolarTermOccurrence | null = null;
  for (const term of candidates) {
    const tKey = dateKey(term.year, term.month, term.day);
    if (tKey > key) {
      continue;
    }
    if (
      best === null ||
      dateKey(best.year, best.month, best.day) < tKey ||
      (dateKey(best.year, best.month, best.day) === tKey &&
        best.atMs < term.atMs)
    ) {
      best = term;
    }
  }
  if (best === null) {
    return null;
  }
  return {
    name: best.name,
    since: { year: best.year, month: best.month, day: best.day },
  };
}

/** 下一节气（严格晚于「今天」本地日的最近交节日）。 */
export function nextSolarTerm(
  date: Date,
  timeZone: string,
): SolarTermOccurrence | null {
  const ymd = ymdInTimeZone(date.getTime(), timeZone);
  if (ymd === null) {
    return null;
  }
  const key = dateKey(ymd.year, ymd.month, ymd.day);
  const candidates = [
    ...solarTermsForYear(ymd.year, timeZone),
    ...solarTermsForYear(ymd.year + 1, timeZone),
  ];
  for (const term of candidates) {
    if (dateKey(term.year, term.month, term.day) > key) {
      return term;
    }
  }
  return null;
}

export { TERM_NAMES };
