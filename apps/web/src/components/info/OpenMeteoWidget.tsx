import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Sun,
  type LucideIcon,
} from "lucide-react";

import type {
  OpenMeteoInfoResponse,
  WeatherDailyItem,
  WeatherHourlyItem,
} from "@homepage/domain";

import { ErrorStatus, LoadingStatus } from "@/components/error";
import {
  fetchInfo,
  isApiClientError,
} from "@/lib/api";
import { chinaAqiInfo, chinaAqiTextClass } from "@/lib/aqi";
import {
  formatPublicError,
  formatUnknownError,
} from "@/lib/format-error";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { formatWindLabel } from "@/lib/wind";

export const OPEN_METEO_REVALIDATE_MS = 15 * 60 * 1000;

/** 前端展示上限（服务端通常已截断） */
const HOURLY_DISPLAY_LIMIT = 12;
const DAILY_DISPLAY_LIMIT = 7;

type ForecastMode = "hourly" | "daily";

export type OpenMeteoWidgetProps = {
  infoId: string;
  className?: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: OpenMeteoInfoResponse };

/** 小米天气状况码 → 中文 */
export function weatherCodeToConditionText(code: number): string {
  if (!Number.isFinite(code)) {
    return "未知";
  }
  const c = Math.trunc(code);
  const map: Record<number, string> = {
    0: "晴",
    1: "多云",
    2: "阴",
    3: "阵雨",
    4: "雷阵雨",
    5: "雷阵雨并伴有冰雹",
    6: "雨夹雪",
    7: "小雨",
    8: "中雨",
    9: "大雨",
    10: "暴雨",
    11: "大暴雨",
    12: "特大暴雨",
    13: "阵雪",
    14: "小雪",
    15: "中雪",
    16: "大雪",
    17: "暴雪",
    18: "雾",
    19: "冻雨",
    20: "沙尘暴",
    21: "小雨-中雨",
    22: "中雨-大雨",
    23: "大雨-暴雨",
    24: "暴雨-大暴雨",
    25: "大暴雨-特大暴雨",
    26: "小雪-中雪",
    27: "中雪-大雪",
    28: "大雪-暴雪",
    29: "浮尘",
    30: "扬沙",
    31: "强沙尘暴",
    32: "飑",
    33: "龙卷风",
    34: "弱高吹雪",
    35: "轻雾",
    53: "霾",
    99: "未知",
  };
  return map[c] ?? "未知";
}

function weatherVisual(code: number | undefined): {
  Icon: LucideIcon;
  wash: string;
  icon: string;
} {
  const c =
    code === undefined || !Number.isFinite(code) ? -1 : Math.trunc(code);
  // 晴
  if (c === 0) {
    return {
      Icon: Sun,
      wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(251,191,36,0.22),transparent_68%)]",
      icon: "text-amber-500 dark:text-amber-300",
    };
  }
  // 多云
  if (c === 1) {
    return {
      Icon: CloudSun,
      wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(56,189,248,0.2),transparent_68%)]",
      icon: "text-sky-500 dark:text-sky-300",
    };
  }
  // 阴
  if (c === 2) {
    return {
      Icon: Cloud,
      wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(148,163,184,0.22),transparent_68%)]",
      icon: "text-slate-500 dark:text-slate-300",
    };
  }
  // 雾 / 轻雾 / 霾
  if (c === 18 || c === 35 || c === 53) {
    return {
      Icon: CloudFog,
      wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(148,163,184,0.24),transparent_68%)]",
      icon: "text-slate-500 dark:text-slate-300",
    };
  }
  // 雨类
  if (
    c === 3 ||
    c === 6 ||
    c === 7 ||
    c === 8 ||
    c === 9 ||
    c === 10 ||
    c === 11 ||
    c === 12 ||
    c === 19 ||
    c === 21 ||
    c === 22 ||
    c === 23 ||
    c === 24 ||
    c === 25
  ) {
    return {
      Icon: CloudRain,
      wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(59,130,246,0.2),transparent_68%)]",
      icon: "text-blue-500 dark:text-blue-300",
    };
  }
  // 雪类
  if (
    c === 13 ||
    c === 14 ||
    c === 15 ||
    c === 16 ||
    c === 17 ||
    c === 26 ||
    c === 27 ||
    c === 28 ||
    c === 34
  ) {
    return {
      Icon: CloudSnow,
      wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(34,211,238,0.18),transparent_68%)]",
      icon: "text-cyan-600 dark:text-cyan-300",
    };
  }
  // 雷阵雨 / 冰雹
  if (c === 4 || c === 5) {
    return {
      Icon: CloudLightning,
      wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(167,139,250,0.22),transparent_68%)]",
      icon: "text-violet-500 dark:text-violet-300",
    };
  }
  // 沙尘等
  return {
    Icon: Cloud,
    wash: "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(148,163,184,0.2),transparent_68%)]",
    icon: "text-slate-500 dark:text-slate-300",
  };
}

function parseOptionalNumber(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  return undefined;
}

function parseOptionalText(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.length > 0) {
      return t;
    }
  }
  return undefined;
}

function parseHourlyItem(raw: unknown): WeatherHourlyItem | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const time = parseOptionalText(obj["time"]);
  const temperatureC = parseOptionalNumber(obj["temperatureC"]);
  if (time === undefined || temperatureC === undefined) {
    return null;
  }
  const weatherCode = parseOptionalNumber(obj["weatherCode"]);
  const conditionText = parseOptionalText(obj["conditionText"]);
  return {
    time,
    temperatureC,
    ...(weatherCode !== undefined ? { weatherCode } : {}),
    ...(conditionText !== undefined ? { conditionText } : {}),
  };
}

function parseDailyItem(raw: unknown): WeatherDailyItem | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const date = parseOptionalText(obj["date"]);
  const temperatureMaxC = parseOptionalNumber(obj["temperatureMaxC"]);
  const temperatureMinC = parseOptionalNumber(obj["temperatureMinC"]);
  if (
    date === undefined ||
    temperatureMaxC === undefined ||
    temperatureMinC === undefined
  ) {
    return null;
  }
  const weatherCode = parseOptionalNumber(obj["weatherCode"]);
  const conditionText = parseOptionalText(obj["conditionText"]);
  return {
    date,
    temperatureMaxC,
    temperatureMinC,
    ...(weatherCode !== undefined ? { weatherCode } : {}),
    ...(conditionText !== undefined ? { conditionText } : {}),
  };
}

export function asOpenMeteoInfo(
  body: unknown,
): OpenMeteoInfoResponse | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const obj = body as Record<string, unknown>;
  if (
    typeof obj["temperatureC"] !== "number" ||
    !Number.isFinite(obj["temperatureC"])
  ) {
    return null;
  }
  const temperatureC = obj["temperatureC"] as number;
  const conditionText = parseOptionalText(obj["conditionText"]);
  const weatherCode = parseOptionalNumber(obj["weatherCode"]);
  const location = parseOptionalText(obj["location"]);

  if (conditionText === undefined && weatherCode === undefined) {
    return null;
  }

  let hourly: WeatherHourlyItem[] | undefined;
  if (Array.isArray(obj["hourly"])) {
    const items: WeatherHourlyItem[] = [];
    for (const entry of obj["hourly"]) {
      const item = parseHourlyItem(entry);
      if (item !== null) {
        items.push(item);
      }
    }
    if (items.length > 0) {
      hourly = items;
    }
  }

  let daily: WeatherDailyItem[] | undefined;
  if (Array.isArray(obj["daily"])) {
    const items: WeatherDailyItem[] = [];
    for (const entry of obj["daily"]) {
      const item = parseDailyItem(entry);
      if (item !== null) {
        items.push(item);
      }
    }
    if (items.length > 0) {
      daily = items;
    }
  }

  const humidityPercent = parseOptionalNumber(obj["humidityPercent"]);
  const aqi = parseOptionalNumber(obj["aqi"]);
  const feelsLikeC = parseOptionalNumber(obj["feelsLikeC"]);
  const windSpeedKmh = parseOptionalNumber(obj["windSpeedKmh"]);
  const windDirectionDeg = parseOptionalNumber(obj["windDirectionDeg"]);
  const sunrise = parseOptionalText(obj["sunrise"]);
  const sunset = parseOptionalText(obj["sunset"]);

  return {
    temperatureC,
    ...(conditionText !== undefined ? { conditionText } : {}),
    ...(weatherCode !== undefined ? { weatherCode } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(humidityPercent !== undefined &&
    humidityPercent >= 0 &&
    humidityPercent <= 100
      ? { humidityPercent }
      : {}),
    ...(aqi !== undefined && aqi >= 0 ? { aqi } : {}),
    ...(feelsLikeC !== undefined ? { feelsLikeC } : {}),
    ...(windSpeedKmh !== undefined && windSpeedKmh >= 0
      ? { windSpeedKmh }
      : {}),
    ...(windDirectionDeg !== undefined &&
    windDirectionDeg >= 0 &&
    windDirectionDeg <= 360
      ? { windDirectionDeg }
      : {}),
    ...(sunrise !== undefined ? { sunrise } : {}),
    ...(sunset !== undefined ? { sunset } : {}),
    ...(hourly !== undefined ? { hourly } : {}),
    ...(daily !== undefined ? { daily } : {}),
  };
}

function formatClockHm(iso: string | undefined): string | null {
  if (iso === undefined) {
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    const m = /T(\d{2}):(\d{2})/.exec(iso);
    return m?.[1] !== undefined && m[2] !== undefined
      ? `${m[1]}:${m[2]}`
      : null;
  }
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function resolveErrorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    if (error.publicError) {
      return formatPublicError(error.publicError, messages.error.info);
    }
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : messages.error.info;
  }
  return formatUnknownError(error, messages.error.info);
}

function resolveConditionText(data: OpenMeteoInfoResponse): string {
  const text = data.conditionText?.trim();
  if (text && text.length > 0) {
    return text;
  }
  if (data.weatherCode !== undefined) {
    return weatherCodeToConditionText(data.weatherCode);
  }
  return "未知";
}

export function formatTemperatureC(value: number): {
  value: string;
  unit: string;
} {
  if (!Number.isFinite(value)) {
    return { value: "—", unit: "°C" };
  }
  const rounded = Math.round(value * 10) / 10;
  const text =
    Number.isInteger(rounded) || Math.abs(rounded % 1) < 1e-9
      ? String(Math.trunc(rounded))
      : rounded.toFixed(1);
  return { value: text, unit: "°C" };
}

function formatHourLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    const m = /T(\d{2})/.exec(iso);
    return m?.[1] !== undefined ? `${m[1]}时` : "—";
  }
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "numeric",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}时`;
  }
}

function formatDayLabel(dateKey: string, index: number): string {
  if (index === 0) {
    return "今天";
  }
  if (index === 1) {
    return "明天";
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (m === null) {
    return dateKey;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  try {
    return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(
      new Date(y, mo - 1, d),
    );
  } catch {
    return `${mo}/${d}`;
  }
}

function ForecastModeToggle({
  mode,
  onChange,
  hasHourly,
  hasDaily,
  labelledBy,
}: {
  mode: ForecastMode;
  onChange: (next: ForecastMode) => void;
  hasHourly: boolean;
  hasDaily: boolean;
  labelledBy: string;
}): JSX.Element | null {
  if (!(hasHourly && hasDaily)) {
    return null;
  }

  const baseBtn =
    "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";
  const activeBtn = "bg-background/80 text-foreground shadow-sm";
  const idleBtn = "text-muted-foreground hover:text-foreground/90";

  return (
    <div
      role="tablist"
      aria-labelledby={labelledBy}
      className="inline-flex items-center gap-0.5 rounded-lg border border-border/50 bg-muted/40 p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "hourly"}
        className={cn(baseBtn, mode === "hourly" ? activeBtn : idleBtn)}
        onClick={() => {
          onChange("hourly");
        }}
      >
        小时
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "daily"}
        className={cn(baseBtn, mode === "daily" ? activeBtn : idleBtn)}
        onClick={() => {
          onChange("daily");
        }}
      >
        天
      </button>
    </div>
  );
}

function HourlyForecastRow({
  items,
}: {
  items: readonly WeatherHourlyItem[];
}): JSX.Element {
  return (
    <ul
      className="flex gap-1 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="逐小时预报"
    >
      {items.map((item) => {
        const visual = weatherVisual(item.weatherCode);
        const Icon = visual.Icon;
        const temp = formatTemperatureC(item.temperatureC);
        const label = formatHourLabel(item.time);
        const condition =
          item.conditionText?.trim() ||
          (item.weatherCode !== undefined
            ? weatherCodeToConditionText(item.weatherCode)
            : undefined);
        return (
          <li
            key={item.time}
            className="flex min-w-[3.1rem] shrink-0 flex-col items-center gap-1 rounded-lg px-1.5 py-1"
            title={condition}
          >
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {label}
            </span>
            <Icon
              aria-hidden="true"
              className={cn("size-4 opacity-90", visual.icon)}
              strokeWidth={1.6}
            />
            <span className="text-xs font-medium tabular-nums text-foreground">
              {temp.value}°
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DailyForecastRow({
  items,
}: {
  items: readonly WeatherDailyItem[];
}): JSX.Element {
  return (
    <ul
      className="flex gap-1 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="逐日预报"
    >
      {items.map((item, index) => {
        const visual = weatherVisual(item.weatherCode);
        const Icon = visual.Icon;
        const maxT = formatTemperatureC(item.temperatureMaxC);
        const minT = formatTemperatureC(item.temperatureMinC);
        const label = formatDayLabel(item.date, index);
        const condition =
          item.conditionText?.trim() ||
          (item.weatherCode !== undefined
            ? weatherCodeToConditionText(item.weatherCode)
            : undefined);
        return (
          <li
            key={item.date}
            className="flex min-w-[3.25rem] shrink-0 flex-col items-center gap-1 rounded-lg px-1.5 py-1"
            title={condition}
          >
            <span className="text-[10px] text-muted-foreground">{label}</span>
            <Icon
              aria-hidden="true"
              className={cn("size-4 opacity-90", visual.icon)}
              strokeWidth={1.6}
            />
            <span className="flex flex-col items-center leading-tight">
              <span className="text-xs font-medium tabular-nums text-foreground">
                {maxT.value}°
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {minT.value}°
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function OpenMeteoWidget({
  infoId,
  className,
}: OpenMeteoWidgetProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [forecastMode, setForecastMode] = useState<ForecastMode>("hourly");
  const abortRef = useRef<AbortController | null>(null);
  const hasSuccessRef = useRef(false);
  const forecastHeadingId = useId();

  const load = useCallback(
    async (signal: AbortSignal, options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent || !hasSuccessRef.current) {
        setState({ status: "loading" });
      }

      try {
        const body = await fetchInfo(infoId, { signal });
        if (signal.aborted) {
          return;
        }

        const data = asOpenMeteoInfo(body);
        if (data === null) {
          hasSuccessRef.current = false;
          setState({
            status: "error",
            message: messages.error.invalidResponse,
          });
          return;
        }

        hasSuccessRef.current = true;
        setState({ status: "success", data });
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return;
        }
        if (silent && hasSuccessRef.current) {
          return;
        }
        hasSuccessRef.current = false;
        setState({
          status: "error",
          message: resolveErrorMessage(error),
        });
      }
    },
    [infoId],
  );

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    void load(controller.signal);

    const timerId = window.setInterval(() => {
      abortRef.current?.abort();
      const next = new AbortController();
      abortRef.current = next;
      void load(next.signal, { silent: true });
    }, OPEN_METEO_REVALIDATE_MS);

    return () => {
      window.clearInterval(timerId);
      controller.abort();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load, reloadToken]);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
    hasSuccessRef.current = false;
    setReloadToken((n) => n + 1);
  }, []);

  const hourlyItems = useMemo(() => {
    if (state.status !== "success") {
      return [] as WeatherHourlyItem[];
    }
    return (state.data.hourly ?? []).slice(0, HOURLY_DISPLAY_LIMIT);
  }, [state]);

  const dailyItems = useMemo(() => {
    if (state.status !== "success") {
      return [] as WeatherDailyItem[];
    }
    return (state.data.daily ?? []).slice(0, DAILY_DISPLAY_LIMIT);
  }, [state]);

  const hasHourly = hourlyItems.length > 0;
  const hasDaily = dailyItems.length > 0;

  const activeMode: ForecastMode = useMemo(() => {
    if (forecastMode === "hourly" && hasHourly) {
      return "hourly";
    }
    if (forecastMode === "daily" && hasDaily) {
      return "daily";
    }
    if (hasHourly) {
      return "hourly";
    }
    return "daily";
  }, [forecastMode, hasHourly, hasDaily]);

  const successData =
    state.status === "success" ? state.data : null;

  const dayRange = useMemo(() => {
    const today = successData?.daily?.[0];
    if (today === undefined) {
      return null;
    }
    const maxT = formatTemperatureC(today.temperatureMaxC);
    const minT = formatTemperatureC(today.temperatureMinC);
    if (maxT.value === "—" || minT.value === "—") {
      return null;
    }
    return `${minT.value}–${maxT.value}°`;
  }, [successData]);

  const metricChips = useMemo(() => {
    if (successData === null) {
      return [] as Array<{
        key: string;
        label: string;
        value: string;
        valueClass?: string;
      }>;
    }
    const chips: Array<{
      key: string;
      label: string;
      value: string;
      valueClass?: string;
    }> = [];

    if (successData.feelsLikeC !== undefined) {
      const f = formatTemperatureC(successData.feelsLikeC);
      if (f.value !== "—") {
        chips.push({ key: "feels", label: "体感", value: `${f.value}°` });
      }
    }

    const h = successData.humidityPercent;
    if (h !== undefined && Number.isFinite(h) && h >= 0 && h <= 100) {
      chips.push({
        key: "humidity",
        label: "湿度",
        value: `${Math.round(h)}%`,
      });
    }

    const wind = formatWindLabel(
      successData.windSpeedKmh,
      successData.windDirectionDeg,
    );
    if (wind !== null) {
      chips.push({ key: "wind", label: "风力", value: wind });
    }

    if (successData.aqi !== undefined) {
      const info = chinaAqiInfo(successData.aqi);
      if (info !== null) {
        chips.push({
          key: "aqi",
          label: "AQI",
          value: `${info.value} ${info.label}`,
          valueClass: chinaAqiTextClass(info.level),
        });
      }
    }

    const rise = formatClockHm(successData.sunrise);
    const set = formatClockHm(successData.sunset);
    if (rise !== null && set !== null) {
      chips.push({
        key: "sun",
        label: "日出日落",
        value: `${rise} / ${set}`,
      });
    } else if (rise !== null) {
      chips.push({ key: "sunrise", label: "日出", value: rise });
    } else if (set !== null) {
      chips.push({ key: "sunset", label: "日落", value: set });
    }

    return chips;
  }, [successData]);

  if (state.status === "loading") {
    return (
      <div
        data-slot="openmeteo-widget"
        data-state="loading"
        className={cn("min-h-[9.5rem] p-4", className)}
      >
        <LoadingStatus message={messages.loading.weather} skeleton />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        data-slot="openmeteo-widget"
        data-state="error"
        className={cn("min-h-[9.5rem] p-4", className)}
      >
        <ErrorStatus message={state.message} onRetry={handleRetry} />
      </div>
    );
  }

  const condition = resolveConditionText(state.data);
  const temperature = formatTemperatureC(state.data.temperatureC);
  const visual = weatherVisual(state.data.weatherCode);
  const WeatherIcon = visual.Icon;
  const location = state.data.location?.trim() || undefined;
  const title = location ?? "天气";
  const ariaLabel = location
    ? `${location} ${temperature.value}${temperature.unit} ${condition}`
    : `天气 ${temperature.value}${temperature.unit} ${condition}`;
  const showForecast = hasHourly || hasDaily;

  return (
    <div
      data-slot="openmeteo-widget"
      data-state="success"
      data-info-id={infoId}
      data-forecast-mode={showForecast ? activeMode : undefined}
      className={cn(
        "relative flex h-full min-h-[9.5rem] flex-col gap-2.5 p-4",
        className,
      )}
      role="status"
      aria-label={ariaLabel}
    >
      <div
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0", visual.wash)}
      />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
            {title}
          </p>
          <div className="mt-2 flex items-end gap-2.5">
            <p className="text-[2.55rem] font-semibold leading-none tracking-tight tabular-nums text-foreground sm:text-[2.75rem]">
              {temperature.value}
              <span className="ml-1 align-top text-base font-medium text-muted-foreground">
                {temperature.unit}
              </span>
            </p>
            <div className="mb-0.5 min-w-0 pb-0.5">
              <p className="text-sm font-medium text-foreground/85">
                {condition}
              </p>
              {dayRange !== null ? (
                <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                  {dayRange}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <WeatherIcon
          aria-hidden="true"
          className={cn("mt-0.5 size-10 shrink-0 opacity-90", visual.icon)}
          strokeWidth={1.5}
        />
      </div>

      {metricChips.length > 0 ? (
        <div className="relative grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {metricChips.map((chip) => (
            <div
              key={chip.key}
              className="rounded-lg border border-border/45 bg-background/35 px-2 py-1.5"
            >
              <p className="text-[10px] tracking-wide text-muted-foreground">
                {chip.label}
              </p>
              <p
                className={cn(
                  "mt-0.5 text-xs font-medium tabular-nums text-foreground/90",
                  chip.valueClass,
                )}
              >
                {chip.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {showForecast ? (
        <div className="relative space-y-2 border-t border-border/40 pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <p
              id={forecastHeadingId}
              className="text-[11px] font-medium tracking-wide text-muted-foreground"
            >
              {activeMode === "hourly" ? "未来小时" : "未来几天"}
            </p>
            <ForecastModeToggle
              mode={activeMode}
              onChange={setForecastMode}
              hasHourly={hasHourly}
              hasDaily={hasDaily}
              labelledBy={forecastHeadingId}
            />
          </div>
          {activeMode === "hourly" && hasHourly ? (
            <HourlyForecastRow items={hourlyItems} />
          ) : null}
          {activeMode === "daily" && hasDaily ? (
            <DailyForecastRow items={dailyItems} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
