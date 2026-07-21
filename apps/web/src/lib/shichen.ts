/** 传统十二时辰（整点边界；子时 23:00–01:00）。 */

export type ShichenInfo = {
  /** 如「午」 */
  name: string;
  /** 如「午时」 */
  label: string;
};

function hourInTimeZone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(date);
    const hourRaw = parts.find((p) => p.type === "hour")?.value;
    const hour = Number(hourRaw);
    if (!Number.isFinite(hour)) {
      return null;
    }
    return hour === 24 ? 0 : hour;
  } catch {
    return null;
  }
}

export function shichenFromDate(
  date: Date,
  timeZone: string,
): ShichenInfo | null {
  const hour = hourInTimeZone(date, timeZone);
  if (hour === null) {
    return null;
  }
  let name: string;
  if (hour >= 23 || hour < 1) name = "子";
  else if (hour < 3) name = "丑";
  else if (hour < 5) name = "寅";
  else if (hour < 7) name = "卯";
  else if (hour < 9) name = "辰";
  else if (hour < 11) name = "巳";
  else if (hour < 13) name = "午";
  else if (hour < 15) name = "未";
  else if (hour < 17) name = "申";
  else if (hour < 19) name = "酉";
  else if (hour < 21) name = "戌";
  else name = "亥";

  return { name, label: `${name}时` };
}

export type YearDayInfo = {
  dayOfYear: number;
  daysInYear: number;
  /** 如「今年第 202 天」 */
  label: string;
  /** 0–100 */
  percent: number;
};

export function yearDayInfo(
  date: Date,
  timeZone: string,
): YearDayInfo | null {
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
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day)
    ) {
      return null;
    }
    const start = Date.UTC(year, 0, 1);
    const current = Date.UTC(year, month - 1, day);
    const dayOfYear = Math.floor((current - start) / 86_400_000) + 1;
    const daysInYear =
      (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
    if (dayOfYear < 1 || dayOfYear > daysInYear) {
      return null;
    }
    const percent = Math.round((dayOfYear / daysInYear) * 1000) / 10;
    return {
      dayOfYear,
      daysInYear,
      label: `今年第 ${dayOfYear} 天`,
      percent,
    };
  } catch {
    return null;
  }
}
