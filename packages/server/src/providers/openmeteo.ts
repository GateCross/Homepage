import {
  OpenMeteoInfoResponseSchema,
  type OpenMeteoInfoResponse,
  type WeatherDailyItem,
  type WeatherHourlyItem,
} from "@homepage/domain";

import {
  HttpLocalError,
  readJsonResponse,
  timedFetch,
  type FetchLike,
} from "../http-utils.js";

/** 小米天气 API（中国天气网城市编码） */
export const XIAOMI_WEATHER_BASE_URL =
  "https://weatherapi.market.xiaomi.com/wtr-v3/weather/all" as const;

export const XIAOMI_WEATHER_APP_KEY = "weather20151024" as const;
export const XIAOMI_WEATHER_SIGN = "zUFJoAR2ZVrDy1vF3D07" as const;

export const OPEN_METEO_TIMEOUT_MS = 10_000;

/** 请求的预报天数（小米侧通常最多返回约 15 天） */
export const XIAOMI_FORECAST_DAYS = 7;

/** 前端展示用：最多返回的小时/日点数 */
export const HOURLY_FORECAST_LIMIT = 24;
export const DAILY_FORECAST_LIMIT = 7;

export type OpenMeteoTarget = {
  cityId: string;
  location: string;
};

export type OpenMeteoProviderDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
};

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

export function parseOpenMeteoTargetOptions(
  options: unknown,
): OpenMeteoTarget | null {
  if (options === null || options === undefined || typeof options !== "object") {
    return null;
  }
  const obj = options as Record<string, unknown>;
  const cityIdRaw = obj["cityId"];
  const locationRaw = obj["location"];
  if (typeof cityIdRaw !== "string" || cityIdRaw.trim().length === 0) {
    return null;
  }
  if (typeof locationRaw !== "string" || locationRaw.trim().length === 0) {
    return null;
  }
  const cityId = cityIdRaw.trim();
  // 仅允许纯数字城市编码，防止注入任意 locationKey
  if (!/^\d{6,12}$/.test(cityId)) {
    return null;
  }
  return {
    cityId,
    location: locationRaw.trim(),
  };
}

export function buildXiaomiWeatherUrl(
  target: OpenMeteoTarget,
  baseUrl: string = XIAOMI_WEATHER_BASE_URL,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("latitude", "0");
  url.searchParams.set("longitude", "0");
  url.searchParams.set("locationKey", `weathercn:${target.cityId}`);
  url.searchParams.set("days", String(XIAOMI_FORECAST_DAYS));
  url.searchParams.set("appKey", XIAOMI_WEATHER_APP_KEY);
  url.searchParams.set("sign", XIAOMI_WEATHER_SIGN);
  url.searchParams.set("isGlobal", "false");
  url.searchParams.set("locale", "zh_cn");
  return url.toString();
}

function readUnitValue(node: unknown): number | null {
  if (node === null || node === undefined) {
    return null;
  }
  if (typeof node === "number" && Number.isFinite(node)) {
    return node;
  }
  if (typeof node === "string") {
    const n = Number(node.trim());
    return Number.isFinite(n) ? n : null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const value = obj["value"];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function readWeatherCode(node: unknown): number | undefined {
  if (typeof node === "number" && Number.isFinite(node)) {
    return Math.trunc(node);
  }
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (trimmed.length === 0) return undefined;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asUnknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** 从 `from`/`to` 结构取白天（from）天气码，缺省回退 to。 */
function readDayWeatherCode(node: unknown): number | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (typeof node !== "object") {
    return readWeatherCode(node);
  }
  const obj = node as Record<string, unknown>;
  return readWeatherCode(obj["from"]) ?? readWeatherCode(obj["to"]);
}

function parseIsoDateTime(raw: unknown): Date | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms);
}

/** 保留带偏移的 ISO 字符串；解析失败时返回 null。 */
function normalizeIsoString(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!Number.isFinite(Date.parse(trimmed))) {
    return null;
  }
  return trimmed;
}

function dateKeyFromIso(iso: string): string | null {
  // 优先取本地日历日（ISO 前 10 位 YYYY-MM-DD）
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  if (m?.[1] !== undefined) {
    return m[1];
  }
  const d = parseIsoDateTime(iso);
  if (d === null) {
    return null;
  }
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function addDaysToDateKey(dateKey: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (m === null) {
    return null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return null;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * 解析小米 forecastHourly。
 * temperature/weather 为平行数组；时间轴优先取 wind.value[].datetime，
 * 否则用 temperature.pubTime 起按小时递推。
 */
export function parseXiaomiHourlyForecast(
  forecastHourly: unknown,
  nowMs: number = Date.now(),
  limit: number = HOURLY_FORECAST_LIMIT,
): WeatherHourlyItem[] {
  const root = asRecord(forecastHourly);
  if (root === null) {
    return [];
  }

  const tempNode = asRecord(root["temperature"]);
  const weatherNode = asRecord(root["weather"]);
  const windNode = asRecord(root["wind"]);

  const temps = asUnknownArray(tempNode?.["value"]);
  if (temps === null || temps.length === 0) {
    return [];
  }
  const codes = asUnknownArray(weatherNode?.["value"]);
  const windValues = asUnknownArray(windNode?.["value"]);

  let startIso: string | null = null;
  if (windValues !== null && windValues.length > 0) {
    const first = asRecord(windValues[0]);
    startIso = normalizeIsoString(first?.["datetime"]);
  }
  if (startIso === null) {
    startIso =
      normalizeIsoString(tempNode?.["pubTime"]) ??
      normalizeIsoString(weatherNode?.["pubTime"]);
  }
  if (startIso === null) {
    return [];
  }

  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) {
    return [];
  }

  const items: WeatherHourlyItem[] = [];
  for (let i = 0; i < temps.length; i += 1) {
    const temperatureC = readUnitValue(temps[i]);
    if (temperatureC === null) {
      continue;
    }

    let timeIso: string | null = null;
    if (windValues !== null) {
      const w = asRecord(windValues[i]);
      timeIso = normalizeIsoString(w?.["datetime"]);
    }
    if (timeIso === null) {
      timeIso = new Date(startMs + i * 3_600_000).toISOString();
    }

    const pointMs = Date.parse(timeIso);
    // 丢弃已过去超过 30 分钟的时点，保留当前整点
    if (Number.isFinite(pointMs) && pointMs < nowMs - 30 * 60_000) {
      continue;
    }

    const weatherCode =
      codes !== null ? readWeatherCode(codes[i]) : undefined;
    const item: WeatherHourlyItem = {
      time: timeIso,
      temperatureC,
      ...(weatherCode !== undefined
        ? {
            weatherCode,
            conditionText: weatherCodeToConditionText(weatherCode),
          }
        : {}),
    };
    items.push(item);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

/**
 * 解析小米 forecastDaily。
 * temperature/weather 为平行数组；日期轴取 sunRiseSet.value[].from 的日历日，
 * 否则用 forecastDaily.pubTime 起按天递推。
 */
export function parseXiaomiDailyForecast(
  forecastDaily: unknown,
  limit: number = DAILY_FORECAST_LIMIT,
): WeatherDailyItem[] {
  const root = asRecord(forecastDaily);
  if (root === null) {
    return [];
  }

  const tempNode = asRecord(root["temperature"]);
  const weatherNode = asRecord(root["weather"]);
  const sunNode = asRecord(root["sunRiseSet"]);

  const temps = asUnknownArray(tempNode?.["value"]);
  if (temps === null || temps.length === 0) {
    return [];
  }
  const codes = asUnknownArray(weatherNode?.["value"]);
  const sunValues = asUnknownArray(sunNode?.["value"]);

  let baseDateKey: string | null = null;
  if (sunValues !== null && sunValues.length > 0) {
    const first = asRecord(sunValues[0]);
    const fromIso = normalizeIsoString(first?.["from"]);
    if (fromIso !== null) {
      baseDateKey = dateKeyFromIso(fromIso);
    }
  }
  if (baseDateKey === null) {
    const pub = normalizeIsoString(root["pubTime"]);
    if (pub !== null) {
      baseDateKey = dateKeyFromIso(pub);
    }
  }
  if (baseDateKey === null) {
    return [];
  }

  const items: WeatherDailyItem[] = [];
  for (let i = 0; i < temps.length; i += 1) {
    const t = asRecord(temps[i]);
    // from = 最高，to = 最低（小米约定）
    const maxC = readUnitValue(t?.["from"] ?? temps[i]);
    const minC = readUnitValue(t?.["to"]);
    if (maxC === null || minC === null) {
      continue;
    }

    let dateKey: string | null = null;
    if (sunValues !== null) {
      const s = asRecord(sunValues[i]);
      const fromIso = normalizeIsoString(s?.["from"]);
      if (fromIso !== null) {
        dateKey = dateKeyFromIso(fromIso);
      }
    }
    if (dateKey === null) {
      dateKey = addDaysToDateKey(baseDateKey, i);
    }
    if (dateKey === null) {
      continue;
    }

    const weatherCode =
      codes !== null ? readDayWeatherCode(codes[i]) : undefined;
    const item: WeatherDailyItem = {
      date: dateKey,
      temperatureMaxC: Math.max(maxC, minC),
      temperatureMinC: Math.min(maxC, minC),
      ...(weatherCode !== undefined
        ? {
            weatherCode,
            conditionText: weatherCodeToConditionText(weatherCode),
          }
        : {}),
    };
    items.push(item);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

export function convertXiaomiWeatherPayload(
  payload: unknown,
  location: string,
  nowMs: number = Date.now(),
): OpenMeteoInfoResponse {
  if (payload === null || typeof payload !== "object") {
    throw new HttpLocalError(
      "天气服务返回了异常结构",
      "other",
      "other",
    );
  }
  const root = payload as Record<string, unknown>;
  const current = root["current"];
  if (current === null || typeof current !== "object") {
    throw new HttpLocalError(
      "天气服务未返回当前气象数据",
      "other",
      "other",
    );
  }
  const cur = current as Record<string, unknown>;
  const tempRaw = readUnitValue(cur["temperature"]);
  if (tempRaw === null) {
    throw new HttpLocalError(
      "天气服务未返回有效温度",
      "other",
      "other",
    );
  }

  const weatherCode = readWeatherCode(cur["weather"]);
  const hourly = parseXiaomiHourlyForecast(root["forecastHourly"], nowMs);
  const daily = parseXiaomiDailyForecast(root["forecastDaily"]);

  const draft: OpenMeteoInfoResponse = {
    temperatureC: tempRaw,
    location,
    ...(weatherCode !== undefined
      ? {
          weatherCode,
          conditionText: weatherCodeToConditionText(weatherCode),
        }
      : { conditionText: "未知" }),
    ...(hourly.length > 0 ? { hourly } : {}),
    ...(daily.length > 0 ? { daily } : {}),
  };

  return OpenMeteoInfoResponseSchema.parse(draft);
}

export async function fetchOpenMeteoInfo(
  target: OpenMeteoTarget,
  deps: OpenMeteoProviderDeps = {},
): Promise<OpenMeteoInfoResponse> {
  const url = buildXiaomiWeatherUrl(
    target,
    deps.baseUrl ?? XIAOMI_WEATHER_BASE_URL,
  );
  let response: Response;
  try {
    response = await timedFetch(url, {
      method: "GET",
      timeoutMs: deps.timeoutMs ?? OPEN_METEO_TIMEOUT_MS,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    if (err instanceof HttpLocalError) {
      if (err.kind === "timeout") {
        throw new HttpLocalError("获取天气信息超时", "timeout", "timeout");
      }
      throw new HttpLocalError("无法获取天气信息", err.kind, err.unreachableReason);
    }
    throw new HttpLocalError("无法获取天气信息", "other", "other");
  }

  if (!response.ok) {
    throw new HttpLocalError(
      "天气服务暂时不可用",
      "other",
      "other",
    );
  }

  let payload: unknown;
  try {
    payload = await readJsonResponse(
      response,
      "天气服务返回了无效的 JSON",
    );
  } catch (err) {
    if (err instanceof HttpLocalError) {
      throw err;
    }
    throw new HttpLocalError("天气服务返回了无效的 JSON", "other", "other");
  }

  try {
    return convertXiaomiWeatherPayload(payload, target.location);
  } catch (err) {
    if (err instanceof HttpLocalError) {
      throw err;
    }
    throw new HttpLocalError("天气数据转换失败", "other", "other");
  }
}
