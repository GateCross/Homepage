/** Immich 服务组件适配器。 - 使用 X-API-Key 请求头 - version=1：/api/server-info/statistics；version=2：/api/server/statistics - API key 不得进入结果或错误 */
import type { Metric, ServiceWidgetResult } from "@homepage/domain";

import { scaleBytes } from "./format.js";
import {
  AdapterLocalError,
  adapterFetch,
  joinBaseUrl,
  readJsonBody,
  toLocalErrorMessage,
  type FetchLike,
} from "./http.js";
import type { AdapterRunInput, ServiceWidgetAdapter } from "./types.js";
import { parseServiceWidgetResult } from "./validate.js";

export const IMMICH_USERS_METRIC_ID = "users" as const;
export const IMMICH_PHOTOS_METRIC_ID = "photos" as const;
export const IMMICH_VIDEOS_METRIC_ID = "videos" as const;
export const IMMICH_STORAGE_METRIC_ID = "storage" as const;

const MISSING_KEY = "Immich 缺少 API 密钥配置";
const STATS_FAIL = "获取 Immich 统计失败";
const STATS_TIMEOUT = "获取 Immich 统计超时";
const STATS_NETWORK = "无法连接 Immich 统计接口";
const STATS_BAD_JSON = "Immich 统计响应不是有效 JSON";
const STATS_BAD_FIELDS = "Immich 统计响应缺少有效字段";

const FIELD_DEFS = [
  {
    id: IMMICH_USERS_METRIC_ID,
    label: "用户",
    field: "users",
    keys: ["usageByUser", "users", "userCount"] as const,
  },
  {
    id: IMMICH_PHOTOS_METRIC_ID,
    label: "照片",
    field: "photos",
    keys: ["photos", "photoCount", "images"] as const,
  },
  {
    id: IMMICH_VIDEOS_METRIC_ID,
    label: "视频",
    field: "videos",
    keys: ["videos", "videoCount"] as const,
  },
  {
    id: IMMICH_STORAGE_METRIC_ID,
    label: "存储",
    field: "storage",
    keys: ["usage", "usageRaw", "storage", "diskUsage"] as const,
  },
] as const;

export type ImmichFetchDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export type ImmichWidgetOptions = {
  /** 1 = 旧路径；2 = Immich ≥ v1.118 */
  version: 1 | 2;
  /** 限制展示字段；空 = 全部 */
  fields: readonly string[];
};

function coerceNonNegNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return Math.max(0, n);
    }
  }
  return null;
}

export function parseImmichOptions(options: unknown): ImmichWidgetOptions {
  const record =
    options !== null &&
    options !== undefined &&
    typeof options === "object" &&
    !Array.isArray(options)
      ? (options as Record<string, unknown>)
      : {};

  let version: 1 | 2 = 1;
  const rawVersion = record["version"];
  if (rawVersion === 2 || rawVersion === "2") {
    version = 2;
  } else if (rawVersion === 1 || rawVersion === "1") {
    version = 1;
  }

  let fields: string[] = [];
  if (Array.isArray(record["fields"])) {
    fields = record["fields"]
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim().toLowerCase())
      .filter((f) => f.length > 0);
  }

  return { version, fields };
}

export function readImmichApiKey(
  secrets: AdapterRunInput["secrets"],
): string | null {
  const key = secrets["key"];
  if (typeof key === "string" && key.length > 0) {
    return key;
  }
  const apiKey = secrets["apiKey"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return apiKey;
  }
  const token = secrets["token"];
  if (typeof token === "string" && token.length > 0) {
    return token;
  }
  return null;
}

function statisticsPath(version: 1 | 2): string {
  return version === 2
    ? "/api/server/statistics"
    : "/api/server-info/statistics";
}

/** usageByUser 可能是数组，取 length 作为用户数 */
function readUsersCount(record: Record<string, unknown>): number | null {
  const byUser = record["usageByUser"];
  if (Array.isArray(byUser)) {
    return byUser.length;
  }
  for (const key of ["users", "userCount"] as const) {
    const n = coerceNonNegNumber(record[key]);
    if (n !== null) {
      return n;
    }
  }
  return null;
}

function readStorageBytes(record: Record<string, unknown>): number | null {
  for (const key of ["usage", "usageRaw", "storage", "diskUsage"] as const) {
    const n = coerceNonNegNumber(record[key]);
    if (n !== null) {
      return n;
    }
  }
  // 部分版本把用量嵌在 usageByUser 各项里，汇总 photos/videos 之外的 usage
  const byUser = record["usageByUser"];
  if (Array.isArray(byUser)) {
    let total = 0;
    let found = false;
    for (const entry of byUser) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry)
      ) {
        const usage = coerceNonNegNumber(
          (entry as Record<string, unknown>)["usage"],
        );
        if (usage !== null) {
          total += usage;
          found = true;
        }
      }
    }
    if (found) {
      return total;
    }
  }
  return null;
}

export function convertImmichStatistics(
  data: unknown,
  fields: readonly string[] = [],
): Metric[] {
  if (
    data === null ||
    data === undefined ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    throw new AdapterLocalError(STATS_BAD_FIELDS);
  }
  const record = data as Record<string, unknown>;
  const allow =
    fields.length === 0 ? null : new Set(fields.map((f) => f.toLowerCase()));

  const metrics: Metric[] = [];
  for (const def of FIELD_DEFS) {
    if (allow !== null && !allow.has(def.field)) {
      continue;
    }

    if (def.field === "users") {
      const users = readUsersCount(record);
      metrics.push({
        id: def.id,
        label: def.label,
        value: Math.trunc(users ?? 0),
        status: "ok",
      });
      continue;
    }

    if (def.field === "storage") {
      const bytes = readStorageBytes(record);
      if (bytes === null) {
        metrics.push({
          id: def.id,
          label: def.label,
          value: 0,
          unit: "B",
          status: "ok",
        });
      } else {
        const scaled = scaleBytes(bytes);
        metrics.push({
          id: def.id,
          label: def.label,
          value: scaled.value,
          unit: scaled.unit,
          status: "ok",
        });
      }
      continue;
    }

    let value: number | null = null;
    for (const key of def.keys) {
      value = coerceNonNegNumber(record[key]);
      if (value !== null) {
        break;
      }
    }
    metrics.push({
      id: def.id,
      label: def.label,
      value: Math.trunc(value ?? 0),
      status: "ok",
    });
  }

  if (metrics.length === 0) {
    throw new AdapterLocalError(STATS_BAD_FIELDS);
  }
  return metrics;
}

async function immichGet(
  baseUrl: string,
  path: string,
  apiKey: string,
  deps: ImmichFetchDeps,
): Promise<unknown> {
  const url = joinBaseUrl(baseUrl, path);
  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
    timeoutMessage: STATS_TIMEOUT,
    networkMessage: STATS_NETWORK,
  };
  if (deps.fetchImpl !== undefined) {
    requestOptions.fetchImpl = deps.fetchImpl;
  }
  if (deps.timeoutMs !== undefined) {
    requestOptions.timeoutMs = deps.timeoutMs;
  }

  let response: Response;
  try {
    response = await adapterFetch(url, requestOptions);
  } catch (err) {
    throw err instanceof AdapterLocalError
      ? err
      : new AdapterLocalError(STATS_NETWORK);
  }

  if (!response.ok) {
    throw new AdapterLocalError(STATS_FAIL);
  }

  return readJsonBody(response, STATS_BAD_JSON);
}

export async function fetchImmichStatistics(
  baseUrl: string,
  apiKey: string,
  options: ImmichWidgetOptions,
  deps: ImmichFetchDeps = {},
): Promise<Metric[]> {
  const json = await immichGet(
    baseUrl,
    statisticsPath(options.version),
    apiKey,
    deps,
  );
  return convertImmichStatistics(json, options.fields);
}

async function runImmich(input: AdapterRunInput): Promise<ServiceWidgetResult> {
  try {
    const apiKey = readImmichApiKey(input.secrets);
    if (apiKey === null) {
      return parseServiceWidgetResult({
        ok: false,
        error: MISSING_KEY,
      });
    }

    const options = parseImmichOptions(input.options);
    const metrics = await fetchImmichStatistics(input.url, apiKey, options);
    return parseServiceWidgetResult({
      ok: true,
      metrics,
    });
  } catch (err) {
    return parseServiceWidgetResult({
      ok: false,
      error: toLocalErrorMessage(err, "Immich 请求失败"),
    });
  }
}

export const immichAdapter: ServiceWidgetAdapter = {
  type: "immich",
  run: runImmich,
};
