import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Clock } from "lucide-react";

import { nextStatutoryHolidayCountdown } from "@/lib/calendar/holidays";
import { lunarFromDate } from "@/lib/calendar/lunar";
import { shichenFromDate } from "@/lib/calendar/shichen";
import { currentSolarTerm, nextSolarTerm } from "@/lib/calendar/solar-terms";
import { cn } from "@/lib/utils";

const DEFAULT_TIMEZONE = "UTC" as const;

const DATETIME_STYLE_VALUES = ["short", "medium", "long"] as const;
type DatetimeStyle = (typeof DATETIME_STYLE_VALUES)[number];
const DATETIME_STYLE_SET = new Set<string>(DATETIME_STYLE_VALUES);

const DISPLAY_LOCALE = "zh-CN";

const TICK_INTERVAL_MS = 1_000;

export type DatetimeFormatOptions = {
  timeStyle?: DatetimeStyle;
  dateStyle?: DatetimeStyle;
  hour12?: boolean;
};

export type ParsedDatetimeOptions = {
  timezone: string;
  format: DatetimeFormatOptions;
  label?: string;
};

export type DateTimeWidgetProps = {
  options?: Record<string, unknown>;
  className?: string;
};

/** 校验 IANA 时区是否可被当前运行时 Intl 接受。 非法输入不得抛出。 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  const tz = timeZone.trim();
  if (tz.length === 0) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(raw: unknown): string {
  try {
    if (typeof raw !== "string") {
      return DEFAULT_TIMEZONE;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return DEFAULT_TIMEZONE;
    }
    if (isValidIanaTimeZone(trimmed)) {
      return trimmed;
    }
    return DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function resolveStyle(raw: unknown): DatetimeStyle | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const token = raw.trim().toLowerCase();
  if (DATETIME_STYLE_SET.has(token)) {
    return token as DatetimeStyle;
  }
  return undefined;
}

export function parseDatetimeOptions(
  options: Record<string, unknown> | undefined,
): ParsedDatetimeOptions {
  try {
    const src =
      options !== null &&
      options !== undefined &&
      typeof options === "object" &&
      !Array.isArray(options)
        ? options
        : {};

    const timezone = resolveTimeZone(src["timezone"]);

    const format: DatetimeFormatOptions = {};
    const formatRaw = src["format"];
    if (
      formatRaw !== null &&
      formatRaw !== undefined &&
      typeof formatRaw === "object" &&
      !Array.isArray(formatRaw)
    ) {
      const f = formatRaw as Record<string, unknown>;
      const timeStyle = resolveStyle(f["timeStyle"]);
      if (timeStyle !== undefined) {
        format.timeStyle = timeStyle;
      }
      const dateStyle = resolveStyle(f["dateStyle"]);
      if (dateStyle !== undefined) {
        format.dateStyle = dateStyle;
      }
      if (typeof f["hour12"] === "boolean") {
        format.hour12 = f["hour12"];
      }
    }

    const result: ParsedDatetimeOptions = { timezone, format };
    if (typeof src["label"] === "string") {
      const trimmed = src["label"].trim();
      if (trimmed.length > 0) {
        result.label = trimmed;
      }
    }

    return result;
  } catch {
    return { timezone: DEFAULT_TIMEZONE, format: {} };
  }
}

function formatPart(
  date: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const tz = resolveTimeZone(timezone);
  try {
    return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
      timeZone: tz,
      ...options,
    }).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
        timeZone: DEFAULT_TIMEZONE,
        ...options,
      }).format(date);
    } catch {
      return "—";
    }
  }
}

function readTimeParts(
  date: Date,
  timezone: string,
  hour12: boolean | undefined,
): { hour: string; minute: string; second: string } {
  const tz = resolveTimeZone(timezone);
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    ...(typeof hour12 === "boolean" ? { hour12 } : { hour12: false }),
  };

  const pick = (parts: Intl.DateTimeFormatPart[]): {
    hour: string;
    minute: string;
    second: string;
  } => {
    const map = new Map(parts.map((p) => [p.type, p.value]));
    return {
      hour: (map.get("hour") ?? "00").padStart(2, "0"),
      minute: (map.get("minute") ?? "00").padStart(2, "0"),
      second: (map.get("second") ?? "00").padStart(2, "0"),
    };
  };

  try {
    return pick(
      new Intl.DateTimeFormat(DISPLAY_LOCALE, opts).formatToParts(date),
    );
  } catch {
    try {
      return pick(
        new Intl.DateTimeFormat(DISPLAY_LOCALE, {
          ...opts,
          timeZone: DEFAULT_TIMEZONE,
        }).formatToParts(date),
      );
    } catch {
      return { hour: "00", minute: "00", second: "00" };
    }
  }
}

export function DateTimeWidget({
  options,
  className,
}: DateTimeWidgetProps): JSX.Element {
  const parsed = useMemo(() => parseDatetimeOptions(options), [options]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    setNow(new Date());
    const timerId = window.setInterval(() => {
      setNow(new Date());
    }, TICK_INTERVAL_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, [
    parsed.timezone,
    parsed.format.dateStyle,
    parsed.format.timeStyle,
    parsed.format.hour12,
  ]);

  const { hour, minute, second } = useMemo(
    () => readTimeParts(now, parsed.timezone, parsed.format.hour12),
    [now, parsed.timezone, parsed.format.hour12],
  );
  const dateLine = useMemo(() => {
    const datePart = formatPart(now, parsed.timezone, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const weekdayPart = formatPart(now, parsed.timezone, {
      weekday: "long",
    });
    return { datePart, weekdayPart };
  }, [now, parsed.timezone]);

  // 历法类信息只依赖本地日历日，避免每秒重算农历/节气/节日
  const localDateKey = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: parsed.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const map = new Map(parts.map((p) => [p.type, p.value]));
      return `${map.get("year")}-${map.get("month")}-${map.get("day")}`;
    } catch {
      return now.toISOString().slice(0, 10);
    }
  }, [now, parsed.timezone]);

  // 仅在本地日历日变化时重算。now 每秒换引用，只作取值来源不进依赖数组，
  // 靠 ref 在日界切换那一刻取到当下时刻，否则日界处农历/节气不会刷新。
  const nowRef = useRef(now);
  nowRef.current = now;

  const calendar = useMemo(() => {
    const anchor = nowRef.current;
    return {
      lunar: lunarFromDate(anchor, parsed.timezone),
      solarTerm: currentSolarTerm(anchor, parsed.timezone),
      upcomingTerm: nextSolarTerm(anchor, parsed.timezone),
      holidayCountdown: nextStatutoryHolidayCountdown(anchor, parsed.timezone),
    };
  }, [localDateKey, parsed.timezone]);
  const { lunar, solarTerm, upcomingTerm, holidayCountdown } = calendar;

  // 时辰约两小时一变，用整点桶避免每秒重算
  const hourBucket = useMemo(() => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: parsed.timezone,
        hour: "2-digit",
        hour12: false,
      }).formatToParts(now);
      return parts.find((p) => p.type === "hour")?.value ?? "";
    } catch {
      return String(now.getHours());
    }
  }, [now, parsed.timezone]);
  const shichen = useMemo(
    () => shichenFromDate(nowRef.current, parsed.timezone),
    [hourBucket, parsed.timezone],
  );
  const label = parsed.label ?? "本地时间";

  const termCountdown = useMemo(() => {
    if (upcomingTerm === null || localDateKey.length < 8) {
      return null;
    }
    const todayMs = Date.parse(`${localDateKey}T00:00:00Z`);
    const termKey = `${upcomingTerm.year}-${String(upcomingTerm.month).padStart(2, "0")}-${String(upcomingTerm.day).padStart(2, "0")}`;
    const termMs = Date.parse(`${termKey}T00:00:00Z`);
    if (!Number.isFinite(todayMs) || !Number.isFinite(termMs)) {
      return null;
    }
    const days = Math.round((termMs - todayMs) / 86_400_000);
    if (days < 0) {
      return null;
    }
    return {
      name: upcomingTerm.name,
      days,
      title: days === 0 ? `今日${upcomingTerm.name}` : upcomingTerm.name,
      detail: days === 0 ? "今天" : `还有 ${days} 天`,
    };
  }, [upcomingTerm, localDateKey]);

  const holidayPanel = useMemo(() => {
    if (holidayCountdown === null) {
      return null;
    }
    const days = holidayCountdown.daysUntil;
    return {
      name: holidayCountdown.holiday.name,
      days,
      title:
        days === 0
          ? `今天 · ${holidayCountdown.holiday.name}`
          : holidayCountdown.holiday.name,
      detail: days === 0 ? "今天" : `还有 ${days} 天`,
    };
  }, [holidayCountdown]);

  const dateMeta = useMemo(() => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDateKey);
    if (match === null) {
      return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const todayUtc = Date.UTC(year, month - 1, day);

    // ISO 8601 周数计算（纯 UTC 算术，不受宿主时区影响）
    const d = new Date(todayUtc);
    const isoDay = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - isoDay);
    const isoYearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const weekNumber = Math.ceil(((d.getTime() - isoYearStart) / 86_400_000 + 1) / 7);

    return {
      monthLabel: `${month}月`,
      dayLabel: String(day).padStart(2, "0"),
      weekNumber,
    };
  }, [localDateKey]);

  return (
    <div
      data-slot="datetime-widget"
      data-timezone={parsed.timezone}
      data-solar-term={solarTerm?.name}
      data-next-holiday={holidayCountdown?.holiday.id}
      data-shichen={shichen?.name}
      className={cn(
        "relative flex h-full min-h-0 flex-col gap-3 p-4 text-left",
        className,
      )}
    >
      {/* 统一 Bento 顶部小节头：左标签 + 右周数/时辰微标 */}
      <div className="relative flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Clock aria-hidden="true" className="size-3.5 text-primary/75" />
          <span>{label}</span>
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {dateMeta !== null ? (
            <span className="rounded-md bg-foreground/[0.045] px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none text-muted-foreground dark:bg-white/[0.06]">
              第 {dateMeta.weekNumber} 周
            </span>
          ) : null}
          {shichen !== null ? (
            <span className="rounded-md bg-foreground/[0.055] px-1.5 py-0.5 text-[10px] font-medium leading-none text-foreground/80 dark:bg-white/[0.08]">
              {shichen.label}
            </span>
          ) : null}
        </div>
      </div>

      {/* 主视觉区：时钟行与历法日期区纵向均匀舒展，避免挤在一起导致上下空旷 */}
      <div className="relative flex flex-1 flex-col justify-evenly gap-3 py-1">
        <div className="flex items-center justify-between gap-4">
          <time
            dateTime={now.toISOString()}
            className="flex items-baseline gap-2"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="text-[3rem] font-semibold leading-none tracking-tight tabular-nums text-foreground sm:text-[3.35rem]">
              {hour}
              <span className="relative -top-[0.06em] mx-0.5 font-normal text-foreground/30">
                :
              </span>
              {minute}
            </span>
            <span className="rounded-md bg-foreground/[0.045] px-1.5 py-0.5 text-xs font-medium tabular-nums leading-none text-muted-foreground dark:bg-white/[0.06]">
              {second}
            </span>
          </time>

          {/* 右侧日历数字徽章：月 / 日 / 星期三层，锚定右半边视觉重心 */}
          {dateMeta !== null ? (
            <div
              aria-hidden="true"
              className="flex w-[4.25rem] shrink-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-foreground/[0.03] text-center shadow-xs dark:border-white/12 dark:bg-white/[0.04]"
            >
              <span className="bg-primary/15 py-1 text-[10px] font-semibold tracking-wide leading-none text-primary dark:bg-primary/20">
                {dateMeta.monthLabel}
              </span>
              <span className="pt-1.5 text-[1.4rem] font-bold leading-none tracking-tight tabular-nums text-foreground">
                {dateMeta.dayLabel}
              </span>
              <span className="pb-1.5 pt-1 text-[10px] font-medium leading-none text-muted-foreground">
                {dateLine.weekdayPart}
              </span>
            </div>
          ) : null}
        </div>

        <div className="min-w-0 space-y-1.5">
          <p className="flex min-w-0 items-baseline gap-2 truncate text-[15px] font-medium leading-snug text-foreground/95">
            <span>{dateLine.datePart}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {dateLine.weekdayPart}
            </span>
          </p>
          {lunar !== null ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-snug text-muted-foreground">
              <span className="truncate">
                农历{lunar.text}
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                {lunar.yearText}
              </span>
              {solarTerm !== null ? (
                <span className="inline-flex shrink-0 items-center rounded-md bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium leading-none text-primary dark:bg-primary/18">
                  {solarTerm.name}
                </span>
              ) : null}
            </div>
          ) : solarTerm !== null ? (
            <span className="inline-flex items-center rounded-md bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium leading-none text-primary dark:bg-primary/18">
              {solarTerm.name}
            </span>
          ) : null}
        </div>
      </div>

      {termCountdown !== null || holidayPanel !== null ? (
        <div className="relative mt-auto grid grid-cols-2 gap-2.5 border-t border-border/45 pt-3 dark:border-white/10">
          {termCountdown !== null ? (
            <div className="flex flex-col justify-between gap-1.5 rounded-xl border border-border/35 bg-foreground/[0.03] px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.04]">
              <p className="text-[10px] font-medium leading-none text-muted-foreground">
                下一节气
              </p>
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 truncate text-[13px] font-semibold leading-none text-foreground">
                  {termCountdown.title}
                </p>
                <p className="inline-flex shrink-0 items-baseline gap-0.5 tabular-nums leading-none">
                  {termCountdown.days === 0 ? (
                    <span className="text-xs font-semibold text-primary">今天</span>
                  ) : (
                    <>
                      <span
                        className={cn(
                          "text-base font-bold leading-none tracking-tight",
                          termCountdown.days <= 3
                            ? "text-primary"
                            : "text-foreground",
                        )}
                      >
                        {termCountdown.days}
                      </span>
                      <span className="text-[11px] leading-none text-muted-foreground">
                        天
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-foreground/[0.02] px-3 py-2 dark:bg-white/[0.02]" />
          )}
          {holidayPanel !== null ? (
            <div className="flex flex-col justify-between gap-1.5 rounded-xl border border-border/35 bg-foreground/[0.03] px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.04]">
              <p className="text-[10px] font-medium leading-none text-muted-foreground">
                下一节日
              </p>
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 truncate text-[13px] font-semibold leading-none text-foreground">
                  {holidayPanel.title}
                </p>
                <p className="inline-flex shrink-0 items-baseline gap-0.5 tabular-nums leading-none">
                  {holidayPanel.days === 0 ? (
                    <span className="text-xs font-semibold text-primary">今天</span>
                  ) : (
                    <>
                      <span
                        className={cn(
                          "text-base font-bold leading-none tracking-tight",
                          holidayPanel.days <= 7
                            ? "text-primary"
                            : "text-foreground",
                        )}
                      >
                        {holidayPanel.days}
                      </span>
                      <span className="text-[11px] leading-none text-muted-foreground">
                        天
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-foreground/[0.02] px-3 py-2 dark:bg-white/[0.02]" />
          )}
        </div>
      ) : null}
    </div>
  );
}
