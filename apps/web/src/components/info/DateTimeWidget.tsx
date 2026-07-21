import { useEffect, useMemo, useState, type JSX } from "react";

import { nextStatutoryHolidayCountdown } from "@/lib/holidays";
import { lunarFromDate } from "@/lib/lunar";
import { shichenFromDate, yearDayInfo } from "@/lib/shichen";
import { currentSolarTerm, nextSolarTerm } from "@/lib/solar-terms";
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

export function formatDateTimeInZone(
  date: Date,
  timezone: string,
  format: DatetimeFormatOptions,
): string {
  const tz = resolveTimeZone(timezone);

  const buildOptions = (
    zone: string,
    includeHour12: boolean,
  ): Intl.DateTimeFormatOptions => {
    const opts: Intl.DateTimeFormatOptions = { timeZone: zone };
    if (format.dateStyle !== undefined) {
      opts.dateStyle = format.dateStyle;
    }
    if (format.timeStyle !== undefined) {
      opts.timeStyle = format.timeStyle;
    }
    if (opts.dateStyle === undefined && opts.timeStyle === undefined) {
      opts.dateStyle = "medium";
      opts.timeStyle = "medium";
    }
    if (includeHour12 && typeof format.hour12 === "boolean") {
      opts.hour12 = format.hour12;
    }
    return opts;
  };

  try {
    return new Intl.DateTimeFormat(
      DISPLAY_LOCALE,
      buildOptions(tz, true),
    ).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat(
        DISPLAY_LOCALE,
        buildOptions(tz, false),
      ).format(date);
    } catch {
      try {
        return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
          timeZone: DEFAULT_TIMEZONE,
          dateStyle: "medium",
          timeStyle: "medium",
        }).format(date);
      } catch {
        try {
          return date.toISOString();
        } catch {
          return "—";
        }
      }
    }
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
  const dateLine = useMemo(
    () =>
      formatPart(now, parsed.timezone, {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      }),
    [now, parsed.timezone],
  );

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

  // 仅在本地日历日变化时重算（故意不把 now 列入依赖）
  const lunar = useMemo(
    () => lunarFromDate(now, parsed.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated by localDateKey
    [localDateKey, parsed.timezone],
  );
  const solarTerm = useMemo(
    () => currentSolarTerm(now, parsed.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated by localDateKey
    [localDateKey, parsed.timezone],
  );
  const upcomingTerm = useMemo(
    () => nextSolarTerm(now, parsed.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated by localDateKey
    [localDateKey, parsed.timezone],
  );
  const holidayCountdown = useMemo(
    () => nextStatutoryHolidayCountdown(now, parsed.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated by localDateKey
    [localDateKey, parsed.timezone],
  );
  const yearInfo = useMemo(
    () => yearDayInfo(now, parsed.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated by localDateKey
    [localDateKey, parsed.timezone],
  );
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
    () => shichenFromDate(now, parsed.timezone),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gated by hourBucket
    [hourBucket, parsed.timezone],
  );
  const label = parsed.label ?? "本地时间";

  const lunarLine = useMemo(() => {
    if (lunar === null && solarTerm === null) {
      return null;
    }
    const parts: string[] = [];
    if (lunar !== null) {
      parts.push(`农历${lunar.text}`);
      if (solarTerm !== null) {
        parts.push(solarTerm.name);
        parts.push(`${lunar.yearGanZhi}·${lunar.animal}`);
      } else {
        parts.push(lunar.yearText);
      }
    } else if (solarTerm !== null) {
      parts.push(solarTerm.name);
    }
    return parts;
  }, [lunar, solarTerm]);

  const termCountdownLabel = useMemo(() => {
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
    if (days <= 0) {
      return `今日${upcomingTerm.name}`;
    }
    return `距${upcomingTerm.name} ${days} 天`;
  }, [upcomingTerm, localDateKey]);

  const metaChips = useMemo(() => {
    const chips: Array<{ key: string; text: string; emphasis?: boolean }> = [];
    if (termCountdownLabel !== null) {
      chips.push({ key: "term", text: termCountdownLabel });
    }
    if (holidayCountdown !== null) {
      chips.push({
        key: "holiday",
        text: holidayCountdown.label,
        emphasis: true,
      });
    }
    return chips;
  }, [termCountdownLabel, holidayCountdown]);

  return (
    <div
      data-slot="datetime-widget"
      data-timezone={parsed.timezone}
      data-solar-term={solarTerm?.name}
      data-next-holiday={holidayCountdown?.holiday.id}
      data-shichen={shichen?.name}
      className={cn(
        "relative flex h-full min-h-[9.5rem] flex-col p-4",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-[radial-gradient(120%_80%_at_0%_0%,rgba(56,189,248,0.18),transparent_70%)]"
      />

      <div className="relative flex items-start justify-between gap-3">
        <p className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {label}
        </p>
        <div className="min-w-0 text-right">
          <p className="text-xs leading-snug text-muted-foreground/90">
            {dateLine}
          </p>
          {lunarLine !== null ? (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/75">
              {lunarLine.map((part, index) => (
                <span key={`${part}-${index}`}>
                  {index > 0 ? (
                    <span className="mx-1 text-muted-foreground/40">·</span>
                  ) : null}
                  {part}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </div>

      <div className="relative flex flex-1 flex-col justify-center gap-3 py-3">
        <time
          dateTime={now.toISOString()}
          className="flex items-baseline gap-1.5 font-semibold tracking-tight text-foreground"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="text-[2.55rem] leading-none tabular-nums sm:text-[2.75rem]">
            {hour}
            <span className="mx-0.5 text-foreground/35">:</span>
            {minute}
          </span>
          <span className="pb-1 text-lg tabular-nums text-muted-foreground">
            {second}
          </span>
          {shichen !== null ? (
            <span className="ml-1 pb-1 text-sm font-medium text-muted-foreground/90">
              {shichen.label}
            </span>
          ) : null}
        </time>

        {yearInfo !== null ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>{yearInfo.label}</span>
              <span className="tabular-nums text-foreground/80">
                {yearInfo.percent}%
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-black/10 ring-1 ring-inset ring-black/5 dark:bg-white/12 dark:ring-white/10"
              role="progressbar"
              aria-valuenow={Math.round(yearInfo.percent)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`本年进度 ${yearInfo.percent}%`}
            >
              <div
                className="h-full rounded-full bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.45)] transition-[width] duration-500 dark:bg-sky-300 dark:shadow-[0_0_10px_rgba(125,211,252,0.55)]"
                style={{
                  width: `${Math.min(100, Math.max(0, yearInfo.percent))}%`,
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {metaChips.length > 0 ? (
        <div className="relative flex flex-wrap gap-1.5">
          {metaChips.map((chip) => (
            <span
              key={chip.key}
              className={cn(
                "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] leading-snug",
                chip.emphasis
                  ? "border-sky-500/25 bg-sky-500/10 text-foreground/90"
                  : "border-border/50 bg-background/40 text-muted-foreground",
              )}
            >
              {chip.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
