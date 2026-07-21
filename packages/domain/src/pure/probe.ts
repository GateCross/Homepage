import {
  DockerStateSchema,
  HttpProbeStateSchema,
  type DockerState,
  type HttpProbeState,
  type HttpUnreachableReason,
  type StatusRange,
} from "../contracts/index.js";

export type NetworkProbeResult =
  | {
      kind: "http";

      statusCode: number;
      latencyMs?: number;
    }
  | {
      kind: "network_error";
      reason: HttpUnreachableReason;
    };

const HTTP_CODE_MIN = 100;
const HTTP_CODE_MAX = 599;

function isHttpCode(n: number): boolean {
  return Number.isInteger(n) && n >= HTTP_CODE_MIN && n <= HTTP_CODE_MAX;
}

function toRange(min: number, max: number): StatusRange | null {
  if (!isHttpCode(min) || !isHttpCode(max) || min > max) {
    return null;
  }
  return { min, max };
}

function parseOneExpected(item: unknown): StatusRange | null {
  if (typeof item === "number" && Number.isFinite(item)) {
    const code = Math.trunc(item);
    return toRange(code, code);
  }

  if (typeof item === "string") {
    const trimmed = item.trim();
    if (trimmed === "") {
      return null;
    }
    const rangeMatch = /^(\d{3})\s*-\s*(\d{3})$/.exec(trimmed);
    if (rangeMatch) {
      return toRange(Number(rangeMatch[1]), Number(rangeMatch[2]));
    }
    if (/^\d{3}$/.test(trimmed)) {
      const code = Number(trimmed);
      return toRange(code, code);
    }
    return null;
  }

  if (item !== null && typeof item === "object") {
    const obj = item as Record<string, unknown>;
    const fromRaw = obj["from"] ?? obj["min"];
    const toRaw = obj["to"] ?? obj["max"];
    if (
      typeof fromRaw === "number" &&
      typeof toRaw === "number" &&
      Number.isFinite(fromRaw) &&
      Number.isFinite(toRaw)
    ) {
      return toRange(Math.trunc(fromRaw), Math.trunc(toRaw));
    }
    // 单码对象：仅提供 from/min 或 to/max 之一且相等语义时不接受，避免歧义
  }

  return null;
}

export function normalizeExpectedStatus(input: unknown): StatusRange[] {
  if (input === undefined || input === null) {
    return [];
  }
  const items = Array.isArray(input) ? input : [input];
  const ranges: StatusRange[] = [];
  for (const item of items) {
    const range = parseOneExpected(item);
    if (range !== null) {
      ranges.push(range);
    }
  }
  return ranges;
}

export function matchesExpected(
  code: number,
  ranges: readonly StatusRange[],
): boolean {
  if (!isHttpCode(code) || ranges.length === 0) {
    return false;
  }
  return ranges.some((range) => code >= range.min && code <= range.max);
}

export function classifyHttpProbe(
  result: NetworkProbeResult,
  expected?: readonly StatusRange[],
): Exclude<HttpProbeState, { status: "loading" }> {
  if (result.kind === "network_error") {
    return { status: "unreachable", reason: result.reason };
  }

  const code = result.statusCode;
  const latencyMs = result.latencyMs;

  if (!isHttpCode(code)) {
    return { status: "unreachable", reason: "other" };
  }

  const base =
    latencyMs === undefined
      ? { httpCode: code }
      : { httpCode: code, latencyMs };

  if (expected === undefined || expected.length === 0) {
    return { status: "reachable", ...base };
  }

  if (matchesExpected(code, expected)) {
    return { status: "reachable", ...base };
  }

  return { status: "reachable_abnormal", ...base };
}

export function isValidHttpProbeState(value: unknown): value is HttpProbeState {
  return HttpProbeStateSchema.safeParse(value).success;
}

export function isValidDockerState(value: unknown): value is DockerState {
  return DockerStateSchema.safeParse(value).success;
}
