/**
 * 公历 → 农历（1900-01-31 ~ 2100-12-31）。
 * 数据表编码自香港天文台公开历表；算法无第三方依赖。
 */

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
] as const;

const LUNAR_MONTHS = [
  "正",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
  "冬",
  "腊",
] as const;

const LUNAR_DAYS = [
  "初一",
  "初二",
  "初三",
  "初四",
  "初五",
  "初六",
  "初七",
  "初八",
  "初九",
  "初十",
  "十一",
  "十二",
  "十三",
  "十四",
  "十五",
  "十六",
  "十七",
  "十八",
  "十九",
  "二十",
  "廿一",
  "廿二",
  "廿三",
  "廿四",
  "廿五",
  "廿六",
  "廿七",
  "廿八",
  "廿九",
  "三十",
] as const;

const GAN = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"] as const;
const ZHI = [
  "子",
  "丑",
  "寅",
  "卯",
  "辰",
  "巳",
  "午",
  "未",
  "申",
  "酉",
  "戌",
  "亥",
] as const;
const ANIMALS = [
  "鼠",
  "牛",
  "虎",
  "兔",
  "龙",
  "蛇",
  "马",
  "羊",
  "猴",
  "鸡",
  "狗",
  "猪",
] as const;

/** 基准：1900-01-31 为农历 1900 年正月初一 */
const BASE_UTC_MS = Date.UTC(1900, 0, 31);
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

export type LunarDate = {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
  yearGanZhi: string;
  animal: string;
  monthText: string;
  dayText: string;
  /** 如「闰六月初八」 */
  text: string;
  /** 如「乙巳年 蛇」 */
  yearText: string;
};

function leapMonth(year: number): number {
  return LUNAR_INFO[year - MIN_YEAR]! & 0xf;
}

function leapDays(year: number): number {
  if (leapMonth(year) === 0) {
    return 0;
  }
  return (LUNAR_INFO[year - MIN_YEAR]! & 0x10000) !== 0 ? 30 : 29;
}

function monthDays(year: number, month: number): number {
  return (LUNAR_INFO[year - MIN_YEAR]! & (0x10000 >> month)) !== 0 ? 30 : 29;
}

function yearDays(year: number): number {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += (LUNAR_INFO[year - MIN_YEAR]! & i) !== 0 ? 1 : 0;
  }
  return sum + leapDays(year);
}

function ymdToUtcMs(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

function clampSolarParts(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const ms = probe.getTime();
  if (ms < BASE_UTC_MS || ms > Date.UTC(MAX_YEAR, 11, 31)) {
    return null;
  }
  return { year, month, day };
}

export function ganZhiYear(lunarYear: number): string {
  // 1984 为甲子年
  const offset = lunarYear - 1984;
  const gan = GAN[((offset % 10) + 10) % 10]!;
  const zhi = ZHI[((offset % 12) + 12) % 12]!;
  return `${gan}${zhi}`;
}

export function zodiacAnimal(lunarYear: number): string {
  // 1984 甲子 = 鼠
  return ANIMALS[(((lunarYear - 1984) % 12) + 12) % 12]!;
}

/**
 * 将公历年月日转为农历。输入按「日历日」理解（与时区无关）。
 * 超出 1900-01-31 ~ 2100-12-31 返回 null。
 */
export function solarToLunar(
  year: number,
  month: number,
  day: number,
): LunarDate | null {
  const solar = clampSolarParts(year, month, day);
  if (solar === null) {
    return null;
  }

  let offset = Math.floor(
    (ymdToUtcMs(solar.year, solar.month, solar.day) - BASE_UTC_MS) / 86_400_000,
  );

  let lunarYear = MIN_YEAR;
  for (; lunarYear <= MAX_YEAR; lunarYear += 1) {
    const days = yearDays(lunarYear);
    if (offset < days) {
      break;
    }
    offset -= days;
  }
  if (lunarYear > MAX_YEAR) {
    return null;
  }

  const leap = leapMonth(lunarYear);
  let isLeap = false;
  let lunarMonth = 1;
  for (; lunarMonth <= 12; lunarMonth += 1) {
    let days = monthDays(lunarYear, lunarMonth);
    if (leap > 0 && lunarMonth === leap + 1 && !isLeap) {
      lunarMonth -= 1;
      isLeap = true;
      days = leapDays(lunarYear);
    }
    if (offset < days) {
      break;
    }
    offset -= days;
    if (isLeap && lunarMonth === leap + 1) {
      isLeap = false;
    }
  }

  const lunarDay = offset + 1;
  const monthName = LUNAR_MONTHS[lunarMonth - 1] ?? String(lunarMonth);
  const monthText = `${isLeap ? "闰" : ""}${monthName}月`;
  const dayText = LUNAR_DAYS[lunarDay - 1] ?? String(lunarDay);
  const yearGanZhi = ganZhiYear(lunarYear);
  const animal = zodiacAnimal(lunarYear);

  return {
    year: lunarYear,
    month: lunarMonth,
    day: lunarDay,
    isLeap,
    yearGanZhi,
    animal,
    monthText,
    dayText,
    text: `${monthText}${dayText}`,
    yearText: `${yearGanZhi}年 · ${animal}`,
  };
}

/**
 * 从带时区的 Date 取出该时区下的公历 Y/M/D，再转农历。
 */
export function lunarFromDate(
  date: Date,
  timeZone: string,
): LunarDate | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(date);
    const map = new Map(parts.map((p) => [p.type, p.value]));
    const y = Number(map.get("year"));
    const m = Number(map.get("month"));
    const d = Number(map.get("day"));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      return null;
    }
    return solarToLunar(y, m, d);
  } catch {
    return null;
  }
}
