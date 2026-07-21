import { useEffect, useMemo, useState, type JSX } from "react";

import { lunarFromDate } from "@/lib/lunar";
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
  const lunar = useMemo(
    () => lunarFromDate(now, parsed.timezone),
    [now, parsed.timezone],
  );
  const label = parsed.label ?? "本地时间";

  return (
    <div
      data-slot="datetime-widget"
      data-timezone={parsed.timezone}
      className={cn(
        "relative flex h-full min-h-[8.75rem] flex-col justify-between p-4",
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
          {lunar !== null ? (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/75">
              农历{lunar.text}
              <span className="mx-1 text-muted-foreground/40">·</span>
              {lunar.yearText}
            </p>
          ) : null}
        </div>
      </div>

      <time
        dateTime={now.toISOString()}
        className="relative mt-4 flex items-baseline gap-1.5 font-semibold tracking-tight text-foreground"
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
      </time>

      <p className="relative mt-3 text-[11px] tracking-wide text-muted-foreground/80">
        {parsed.timezone}
      </p>
    </div>
  );
}
