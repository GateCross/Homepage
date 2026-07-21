/**
 * 中国大陆法定节日「节日当天」（不含调休/补班）。
 * 固定公历：元旦、劳动节、国庆；农历：春节、端午、中秋；节气：清明。
 */

import { solarToLunar } from "@/lib/lunar";
import { solarTermsForYear } from "@/lib/solar-terms";

export type StatutoryHolidayId =
  | "new-year"
  | "spring-festival"
  | "qingming"
  | "labor-day"
  | "dragon-boat"
  | "mid-autumn"
  | "national-day";

export type StatutoryHoliday = {
  id: StatutoryHolidayId;
  /** 展示名 */
  name: string;
  year: number;
  month: number;
  day: number;
};

const FIXED: ReadonlyArray<{
  id: StatutoryHolidayId;
  name: string;
  month: number;
  day: number;
}> = [
  { id: "new-year", name: "元旦", month: 1, day: 1 },
  { id: "labor-day", name: "劳动节", month: 5, day: 1 },
  { id: "national-day", name: "国庆", month: 10, day: 1 },
];

const LUNAR: ReadonlyArray<{
  id: StatutoryHolidayId;
  name: string;
  lunarMonth: number;
  lunarDay: number;
}> = [
  { id: "spring-festival", name: "春节", lunarMonth: 1, lunarDay: 1 },
  { id: "dragon-boat", name: "端午", lunarMonth: 5, lunarDay: 5 },
  { id: "mid-autumn", name: "中秋", lunarMonth: 8, lunarDay: 15 },
];

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function ymdInTimeZone(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(date);
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

function daysBetweenKeys(fromKey: string, toKey: string): number {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return Number.NaN;
  }
  return Math.round((b - a) / 86_400_000);
}

/** 在公历 [startYear, endYear] 查找农历月日对应的公历日。 */
function findLunarInSolarRange(
  startYear: number,
  endYear: number,
  lunarMonth: number,
  lunarDay: number,
): Array<{ year: number; month: number; day: number }> {
  const hits: Array<{ year: number; month: number; day: number }> = [];
  for (let y = startYear; y <= endYear; y += 1) {
    let foundInYear = false;
    for (let m = 1; m <= 12 && !foundInYear; m += 1) {
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = 1; d <= dim; d += 1) {
        const lunar = solarToLunar(y, m, d);
        if (
          lunar !== null &&
          !lunar.isLeap &&
          lunar.month === lunarMonth &&
          lunar.day === lunarDay
        ) {
          hits.push({ year: y, month: m, day: d });
          foundInYear = true;
          break;
        }
      }
    }
  }
  return hits;
}

const holidayYearCache = new Map<string, StatutoryHoliday[]>();

/** 指定公历年的全部法定节日当天（按日期升序）。 */
export function statutoryHolidaysForYear(
  year: number,
  timeZone: string = "UTC",
): StatutoryHoliday[] {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    return [];
  }

  const cacheKey = `${year}|${timeZone}`;
  const cached = holidayYearCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const list: StatutoryHoliday[] = [];

  for (const f of FIXED) {
    list.push({
      id: f.id,
      name: f.name,
      year,
      month: f.month,
      day: f.day,
    });
  }

  for (const l of LUNAR) {
    const hits = findLunarInSolarRange(year - 1, year, l.lunarMonth, l.lunarDay);
    for (const h of hits) {
      if (h.year === year) {
        list.push({
          id: l.id,
          name: l.name,
          year: h.year,
          month: h.month,
          day: h.day,
        });
      }
    }
  }

  const terms = solarTermsForYear(year, timeZone);
  const qingming = terms.find((t) => t.name === "清明");
  if (qingming !== undefined && qingming.year === year) {
    list.push({
      id: "qingming",
      name: "清明",
      year: qingming.year,
      month: qingming.month,
      day: qingming.day,
    });
  }

  list.sort((a, b) =>
    dateKey(a.year, a.month, a.day).localeCompare(dateKey(b.year, b.month, b.day)),
  );
  holidayYearCache.set(cacheKey, list);
  return list;
}

export type NextHolidayCountdown = {
  holiday: StatutoryHoliday;
  /** 距节日的整天数；0 表示今天 */
  daysUntil: number;
  /** 底部展示文案 */
  label: string;
};

/**
 * 下一法定节日倒计时（含今天；跨年取明年）。
 */
export function nextStatutoryHolidayCountdown(
  date: Date,
  timeZone: string,
): NextHolidayCountdown | null {
  const ymd = ymdInTimeZone(date, timeZone);
  if (ymd === null) {
    return null;
  }
  const todayKey = dateKey(ymd.year, ymd.month, ymd.day);

  const pool = [
    ...statutoryHolidaysForYear(ymd.year, timeZone),
    ...statutoryHolidaysForYear(ymd.year + 1, timeZone),
  ];

  for (const h of pool) {
    const key = dateKey(h.year, h.month, h.day);
    if (key < todayKey) {
      continue;
    }
    const daysUntil = daysBetweenKeys(todayKey, key);
    if (!Number.isFinite(daysUntil) || daysUntil < 0) {
      continue;
    }
    const label =
      daysUntil === 0
        ? `今天 · ${h.name}`
        : `${h.name} · 还有 ${daysUntil} 天`;
    return { holiday: h, daysUntil, label };
  }
  return null;
}
