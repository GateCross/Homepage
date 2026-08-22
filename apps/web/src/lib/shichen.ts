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
