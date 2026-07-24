/** Caddy 管理 API 服务组件适配器。 - 无鉴权 - GET {url}/reverse_proxy/upstreams - 指标：上游数 / 请求数 / 失败数 */
import type { Metric, ServiceWidgetResult } from "@homepage/domain";

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

export const CADDY_UPSTREAMS_METRIC_ID = "upstreams" as const;
export const CADDY_REQUESTS_METRIC_ID = "requests" as const;
export const CADDY_REQUESTS_FAILED_METRIC_ID = "requests_failed" as const;

const STATS_FAIL = "获取 Caddy 上游状态失败";
const STATS_TIMEOUT = "获取 Caddy 上游状态超时";
const STATS_NETWORK = "无法连接 Caddy 管理接口";
const STATS_BAD_JSON = "Caddy 上游响应不是有效 JSON";
const STATS_BAD_FIELDS = "Caddy 上游响应格式无效";

const FIELD_DEFS = [
  {
    id: CADDY_UPSTREAMS_METRIC_ID,
    label: "上游",
    field: "upstreams",
  },
  {
    id: CADDY_REQUESTS_METRIC_ID,
    label: "请求",
    field: "requests",
  },
  {
    id: CADDY_REQUESTS_FAILED_METRIC_ID,
    label: "失败",
    field: "requests_failed",
  },
] as const;

export type CaddyFetchDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export type CaddyWidgetOptions = {
  /** 限制展示字段；空 = 全部 */
  fields: readonly string[];
};

function coerceNonNegNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return Math.max(0, n);
    }
  }
  return 0;
}

export function parseCaddyOptions(options: unknown): CaddyWidgetOptions {
  const record =
    options !== null &&
    options !== undefined &&
    typeof options === "object" &&
    !Array.isArray(options)
      ? (options as Record<string, unknown>)
      : {};

  let fields: string[] = [];
  if (Array.isArray(record["fields"])) {
    fields = record["fields"]
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim().toLowerCase())
      .filter((f) => f.length > 0);
  }

  return { fields };
}

export function convertCaddyUpstreams(
  data: unknown,
  fields: readonly string[] = [],
): Metric[] {
  if (!Array.isArray(data)) {
    throw new AdapterLocalError(STATS_BAD_FIELDS);
  }

  let requests = 0;
  let fails = 0;
  for (const entry of data) {
    if (
      entry === null ||
      entry === undefined ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    requests += coerceNonNegNumber(
      record["num_requests"] ?? record["numRequests"] ?? record["requests"],
    );
    fails += coerceNonNegNumber(
      record["fails"] ?? record["num_fails"] ?? record["failures"],
    );
  }

  const values: Record<string, number> = {
    upstreams: data.length,
    requests: Math.trunc(requests),
    requests_failed: Math.trunc(fails),
  };

  const allow =
    fields.length === 0 ? null : new Set(fields.map((f) => f.toLowerCase()));

  const metrics: Metric[] = [];
  for (const def of FIELD_DEFS) {
    if (allow !== null && !allow.has(def.field)) {
      continue;
    }
    metrics.push({
      id: def.id,
      label: def.label,
      value: values[def.field] ?? 0,
      status: "ok",
    });
  }

  if (metrics.length === 0) {
    throw new AdapterLocalError(STATS_BAD_FIELDS);
  }
  return metrics;
}

export async function fetchCaddyUpstreams(
  baseUrl: string,
  options: CaddyWidgetOptions,
  deps: CaddyFetchDeps = {},
): Promise<Metric[]> {
  const url = joinBaseUrl(baseUrl, "/reverse_proxy/upstreams");
  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "GET",
    headers: {
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

  const json = await readJsonBody(response, STATS_BAD_JSON);
  return convertCaddyUpstreams(json, options.fields);
}

async function runCaddy(input: AdapterRunInput): Promise<ServiceWidgetResult> {
  try {
    const options = parseCaddyOptions(input.options);
    const metrics = await fetchCaddyUpstreams(input.url, options);
    return parseServiceWidgetResult({
      ok: true,
      metrics,
    });
  } catch (err) {
    return parseServiceWidgetResult({
      ok: false,
      error: toLocalErrorMessage(err, "Caddy 请求失败"),
    });
  }
}

export const caddyAdapter: ServiceWidgetAdapter = {
  type: "caddy",
  run: runCaddy,
};
