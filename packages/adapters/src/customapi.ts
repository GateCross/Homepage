/** ath：点分隔键 + 非负数组下标；拒绝原型链/表达式 - format 白名单：number | percent | bytes | duration | text - 单 mapping 失败隔离 */
import type { Metric, MetricStatus, ServiceWidgetResult } from "@homepage/domain";

import {
  coerceFiniteNumber,
  formatDurationSeconds,
  formatPercentValue,
  scaleBytes,
} from "./format.js";
import {
  AdapterLocalError,
  adapterFetch,
  readJsonBody,
  toLocalErrorMessage,
  type FetchLike,
} from "./http.js";
import type { AdapterRunInput, ServiceWidgetAdapter } from "./types.js";
import { parseServiceWidgetResult } from "./validate.js";

export const CUSTOM_API_FORMATS = [
  "number",
  "percent",
  "bytes",
  "duration",
  "text",
] as const;

export type CustomApiFormat = (typeof CUSTOM_API_FORMATS)[number];

const FORMAT_SET = new Set<string>(CUSTOM_API_FORMATS);

/** 禁止出现在路径段中的原型链/危险键（大小写不敏感匹配） */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const REQUEST_FAIL = "Custom API 请求失败";
const REQUEST_TIMEOUT = "Custom API 请求超时";
const REQUEST_NETWORK = "无法连接 Custom API";
const BAD_JSON = "Custom API 返回了无效的 JSON";

export type CustomApiMapping = {
  id?: string;
  label?: string;
  field?: string;
  path?: string;
  format?: string;
};

export type CustomApiOptions = {
  method?: string;
  headers?: Record<string, string>;
  mappings?: unknown[];
};

export type CustomApiFetchDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export function parseDotPath(raw: string): string[] | null {
  if (typeof raw !== "string") {
    return null;
  }
  const path = raw.trim();
  if (path.length === 0) {
    return null;
  }
  // 禁止括号、引号、运算符等表达式痕迹
  if (/[()[\]{}"'`+\-*/%=<>!&|?:;\\]/.test(path)) {
    return null;
  }
  // 禁止空白
  if (/\s/.test(path)) {
    return null;
  }

  const segments = path.split(".");
  if (segments.length === 0) {
    return null;
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      return null;
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) {
      return null;
    }
    // 纯数字段：非负整数规范形式（允许 0、10；拒绝 01）
    if (/^\d+$/.test(segment)) {
      if (segment.length > 1 && segment.startsWith("0")) {
        return null;
      }
      continue;
    }
    // 普通键：字母/下划线开头，可含字母数字下划线连字符；允许常见 Unicode 字母键
    const asciiKey = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment);
    const unicodeKey = /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(segment);
    if (!asciiKey && !unicodeKey) {
      return null;
    }
  }

  return segments;
}

export function getValueByDotPath(root: unknown, path: string): unknown {
  const segments = parseDotPath(path);
  if (segments === null) {
    return undefined;
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (/^\d+$/.test(segment)) {
      const index = Number(segment);
      if (!Array.isArray(current)) {
        return undefined;
      }
      if (index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    // 拒绝原型链读取：仅 hasOwnProperty
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolveMappingPath(mapping: CustomApiMapping): string | null {
  if (typeof mapping.field === "string" && mapping.field.trim().length > 0) {
    return mapping.field.trim();
  }
  if (typeof mapping.path === "string" && mapping.path.trim().length > 0) {
    return mapping.path.trim();
  }
  return null;
}

function isCustomApiFormat(value: string): value is CustomApiFormat {
  return FORMAT_SET.has(value);
}

export function formatMappingValue(
  raw: unknown,
  format: string | undefined,
): {
  value: string | number;
  unit?: string;
  status?: MetricStatus;
} | null {
  const fmt =
    format === undefined || format.trim().length === 0
      ? "text"
      : format.trim().toLowerCase();

  if (!isCustomApiFormat(fmt)) {
    return {
      value: "不可用",
      status: "unavailable",
    };
  }

  switch (fmt) {
    case "number": {
      const n = coerceFiniteNumber(raw);
      if (n === null) {
        return null;
      }
      return { value: n, status: "ok" };
    }
    case "percent": {
      const p = formatPercentValue(raw);
      if (p === null) {
        return null;
      }
      return { value: p, unit: "%", status: "ok" };
    }
    case "bytes": {
      const n = coerceFiniteNumber(raw);
      if (n === null) {
        return null;
      }
      const scaled = scaleBytes(n);
      return { value: scaled.value, unit: scaled.unit, status: "ok" };
    }
    case "duration": {
      const n = coerceFiniteNumber(raw);
      if (n === null) {
        return null;
      }
      return { value: formatDurationSeconds(n), status: "ok" };
    }
    case "text": {
      if (raw === null || raw === undefined) {
        return null;
      }
      if (typeof raw === "string") {
        return { value: raw, status: "ok" };
      }
      if (typeof raw === "number" || typeof raw === "boolean") {
        return { value: String(raw), status: "ok" };
      }
      // 对象/数组不自动 JSON 化（避免意外体积）；视为失败隔离
      return null;
    }
    default: {
      return {
        value: "不可用",
        status: "unavailable",
      };
    }
  }
}

function unavailableMetric(id: string, label: string): Metric {
  return {
    id,
    label,
    value: "不可用",
    status: "unavailable",
  };
}

export function normalizeMappingEntry(
  raw: unknown,
  index: number,
): CustomApiMapping | null {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const src = raw as Record<string, unknown>;
  const entry: CustomApiMapping = {};
  if (typeof src["id"] === "string") {
    entry.id = src["id"];
  }
  if (typeof src["label"] === "string") {
    entry.label = src["label"];
  }
  if (typeof src["field"] === "string") {
    entry.field = src["field"];
  }
  if (typeof src["path"] === "string") {
    entry.path = src["path"];
  }
  if (typeof src["format"] === "string") {
    entry.format = src["format"];
  }
  // 至少要有 label 或路径之一才有意义；无 label 时用默认中文
  void index;
  return entry;
}

export function mapCustomApiResponse(
  data: unknown,
  mappings: readonly unknown[],
): Metric[] {
  const metrics: Metric[] = [];
  const seenIds = new Set<string>();

  mappings.forEach((rawMapping, index) => {
    const mapping = normalizeMappingEntry(rawMapping, index);
    if (mapping === null) {
      return;
    }

    const labelRaw =
      typeof mapping.label === "string" && mapping.label.trim().length > 0
        ? mapping.label.trim()
        : `指标${index + 1}`;
    // 标签必须含中文才能通过 validateSuccessMetrics；无中文时补前缀
    const label = /[\u3400-\u9FFF]/.test(labelRaw)
      ? labelRaw
      : `指标 ${labelRaw}`;

    let id =
      typeof mapping.id === "string" && mapping.id.trim().length > 0
        ? mapping.id.trim()
        : `mapping_${index}`;
    if (seenIds.has(id)) {
      id = `${id}_${index}`;
    }
    seenIds.add(id);

    try {
      const path = resolveMappingPath(mapping);
      if (path === null || parseDotPath(path) === null) {
        metrics.push(unavailableMetric(id, label));
        return;
      }

      const rawValue = getValueByDotPath(data, path);
      if (rawValue === undefined) {
        metrics.push(unavailableMetric(id, label));
        return;
      }

      const formatted = formatMappingValue(rawValue, mapping.format);
      if (formatted === null) {
        metrics.push(unavailableMetric(id, label));
        return;
      }

      const metric: Metric = {
        id,
        label,
        value: formatted.value,
      };
      if (formatted.unit !== undefined) {
        metric.unit = formatted.unit;
      }
      if (formatted.status !== undefined) {
        metric.status = formatted.status;
      }
      metrics.push(metric);
    } catch {
      metrics.push(unavailableMetric(id, label));
    }
  });

  return metrics;
}

export function parseCustomApiOptions(options: unknown): CustomApiOptions {
  if (
    options === null ||
    options === undefined ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    return { method: "GET", mappings: [] };
  }
  const src = options as Record<string, unknown>;
  const result: CustomApiOptions = { method: "GET" };

  if (typeof src["method"] === "string") {
    result.method = src["method"];
  }

  if (
    src["headers"] !== null &&
    src["headers"] !== undefined &&
    typeof src["headers"] === "object" &&
    !Array.isArray(src["headers"])
  ) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      src["headers"] as Record<string, unknown>,
    )) {
      if (typeof v === "string") {
        headers[k] = v;
      }
    }
    result.headers = headers;
  }

  if (Array.isArray(src["mappings"])) {
    result.mappings = src["mappings"];
  } else {
    result.mappings = [];
  }

  return result;
}

export async function fetchCustomApiMetrics(
  url: string,
  options: CustomApiOptions,
  deps: CustomApiFetchDeps = {},
): Promise<Metric[]> {
  const method = (options.method ?? "GET").trim().toUpperCase();
  if (method !== "GET") {
    throw new AdapterLocalError("Custom API 仅支持 GET 方法");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.headers !== undefined) {
    for (const [k, v] of Object.entries(options.headers)) {
      // 不覆盖调用方已插值的头；Accept 可被覆盖
      headers[k] = v;
    }
  }

  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "GET",
    headers,
    // 明确不传 body
    timeoutMessage: REQUEST_TIMEOUT,
    networkMessage: REQUEST_NETWORK,
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
      : new AdapterLocalError(REQUEST_NETWORK);
  }

  if (!response.ok) {
    throw new AdapterLocalError(REQUEST_FAIL);
  }

  const json = await readJsonBody(response, BAD_JSON);
  return mapCustomApiResponse(json, options.mappings ?? []);
}

async function runCustomApi(
  input: AdapterRunInput,
): Promise<ServiceWidgetResult> {
  try {
    const options = parseCustomApiOptions(input.options);
    const metrics = await fetchCustomApiMetrics(input.url, options);
    return parseServiceWidgetResult({
      ok: true,
      metrics,
    });
  } catch (err) {
    return parseServiceWidgetResult({
      ok: false,
      error: toLocalErrorMessage(err, "Custom API 请求失败"),
    });
  }
}

export const customApiAdapter: ServiceWidgetAdapter = {
  type: "customapi",
  run: runCustomApi,
};
