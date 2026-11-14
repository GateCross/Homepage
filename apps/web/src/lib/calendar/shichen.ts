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
  const name = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"][
    Math.floor(((hour + 1) % 24) / 2)
  ]!;
  return { name, label: `${name}时` };
}
