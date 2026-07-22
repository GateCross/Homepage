/** Transmission 服务组件适配器。 RPC 会话头与账号不得进入结果、错误消息或日志。 */
import type { Metric, ServiceWidgetResult } from "@homepage/domain";

import { scaleByteRate } from "./format.js";
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

export const TRANSMISSION_DOWNLOAD_METRIC_ID = "download" as const;
export const TRANSMISSION_UPLOAD_METRIC_ID = "upload" as const;
export const TRANSMISSION_DOWNLOADING_COUNT_METRIC_ID = "downloading" as const;
export const TRANSMISSION_SEEDING_COUNT_METRIC_ID = "seeding" as const;

const RPC_FAIL = "获取 Transmission 状态失败";
const RPC_TIMEOUT = "获取 Transmission 状态超时";
const RPC_NETWORK = "无法连接 Transmission RPC 接口";
const RPC_BAD_JSON = "Transmission RPC 响应不是有效 JSON";
const RPC_BAD_FIELDS = "Transmission RPC 响应缺少必要字段";
const SESSION_ID_FAIL = "Transmission 未返回有效会话头";

/** libtransmission 状态码：下载中 / 做种中 */
const TR_STATUS_DOWNLOAD_WAIT = 3;
const TR_STATUS_DOWNLOAD = 4;
const TR_STATUS_SEED_WAIT = 5;
const TR_STATUS_SEED = 6;

export type TransmissionAuth = {
  username?: string | undefined;
  password?: string | undefined;
};

export type TransmissionFetchDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

function encodeBasicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`;
  // Node / 浏览器均可：优先 Buffer，回退 btoa
  if (typeof Buffer !== "undefined") {
    return Buffer.from(raw, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function buildAuthHeader(auth: TransmissionAuth): string | undefined {
  if (
    typeof auth.username !== "string" ||
    auth.username.length === 0 ||
    typeof auth.password !== "string"
  ) {
    return undefined;
  }
  return `Basic ${encodeBasicAuth(auth.username, auth.password)}`;
}

function readSessionId(response: Response): string | null {
  const header =
    response.headers.get("X-Transmission-Session-Id") ??
    response.headers.get("x-transmission-session-id");
  if (header === null || header.trim().length === 0) {
    return null;
  }
  return header.trim();
}

export async function transmissionRpc(
  baseUrl: string,
  auth: TransmissionAuth,
  method: string,
  args: Record<string, unknown> = {},
  deps: TransmissionFetchDeps = {},
  sessionId?: string,
): Promise<{ status: number; body: unknown; sessionId: string | null }> {
  const url = joinBaseUrl(baseUrl, "/transmission/rpc");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const authHeader = buildAuthHeader(auth);
  if (authHeader !== undefined) {
    headers["Authorization"] = authHeader;
  }
  if (sessionId !== undefined && sessionId.length > 0) {
    headers["X-Transmission-Session-Id"] = sessionId;
  }

  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "POST",
    headers,
    body: JSON.stringify({ method, arguments: args }),
    timeoutMessage: RPC_TIMEOUT,
    networkMessage: RPC_NETWORK,
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
      : new AdapterLocalError(RPC_NETWORK);
  }

  const nextSessionId = readSessionId(response) ?? sessionId ?? null;

  // 409：需携带会话头重试；body 可能不是 JSON
  if (response.status === 409) {
    return { status: 409, body: null, sessionId: nextSessionId };
  }

  if (!response.ok) {
    return { status: response.status, body: null, sessionId: nextSessionId };
  }

  const body = await readJsonBody(response, RPC_BAD_JSON);
  return { status: response.status, body, sessionId: nextSessionId };
}

export async function callTransmissionRpc(
  baseUrl: string,
  auth: TransmissionAuth,
  method: string,
  args: Record<string, unknown> = {},
  deps: TransmissionFetchDeps = {},
): Promise<unknown> {
  let sessionId: string | undefined;
  // 最多：无会话 → 409 取会话 → 再请求一次
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await transmissionRpc(
      baseUrl,
      auth,
      method,
      args,
      deps,
      sessionId,
    );
    if (result.status === 409) {
      if (result.sessionId === null || result.sessionId.length === 0) {
        throw new AdapterLocalError(SESSION_ID_FAIL);
      }
      sessionId = result.sessionId;
      continue;
    }
    if (result.status < 200 || result.status >= 300 || result.body === null) {
      throw new AdapterLocalError(RPC_FAIL);
    }
    return result.body;
  }
  throw new AdapterLocalError(SESSION_ID_FAIL);
}

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

export function parseSessionStats(body: unknown): {
  downloadBps: number;
  uploadBps: number;
} {
  if (
    body === null ||
    body === undefined ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new AdapterLocalError(RPC_BAD_FIELDS);
  }
  const root = body as Record<string, unknown>;
  const args =
    root["arguments"] !== null &&
    root["arguments"] !== undefined &&
    typeof root["arguments"] === "object" &&
    !Array.isArray(root["arguments"])
      ? (root["arguments"] as Record<string, unknown>)
      : root;

  const dl = coerceNonNegNumber(args["downloadSpeed"]);
  const up = coerceNonNegNumber(args["uploadSpeed"]);
  if (dl === null || up === null) {
    throw new AdapterLocalError(RPC_BAD_FIELDS);
  }
  return { downloadBps: dl, uploadBps: up };
}

export function countTransmissionTorrents(body: unknown): {
  downloading: number;
  seeding: number;
} {
  if (
    body === null ||
    body === undefined ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new AdapterLocalError(RPC_BAD_FIELDS);
  }
  const root = body as Record<string, unknown>;
  const args =
    root["arguments"] !== null &&
    root["arguments"] !== undefined &&
    typeof root["arguments"] === "object" &&
    !Array.isArray(root["arguments"])
      ? (root["arguments"] as Record<string, unknown>)
      : root;
  const torrents = args["torrents"];
  if (!Array.isArray(torrents)) {
    throw new AdapterLocalError(RPC_BAD_FIELDS);
  }

  let downloading = 0;
  let seeding = 0;
  for (const item of torrents) {
    if (
      item === null ||
      item === undefined ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      continue;
    }
    const status = coerceNonNegNumber(
      (item as Record<string, unknown>)["status"],
    );
    if (status === null) {
      continue;
    }
    if (status === TR_STATUS_DOWNLOAD || status === TR_STATUS_DOWNLOAD_WAIT) {
      downloading += 1;
    } else if (status === TR_STATUS_SEED || status === TR_STATUS_SEED_WAIT) {
      seeding += 1;
    }
  }
  return { downloading, seeding };
}

export function buildTransmissionMetrics(
  downloadBps: number,
  uploadBps: number,
  downloadingCount: number,
  seedingCount: number,
): Metric[] {
  const dlScaled = scaleByteRate(downloadBps);
  const upScaled = scaleByteRate(uploadBps);
  return [
    {
      id: TRANSMISSION_DOWNLOAD_METRIC_ID,
      label: "下载",
      value: dlScaled.value,
      unit: dlScaled.unit,
      status: "ok",
    },
    {
      id: TRANSMISSION_UPLOAD_METRIC_ID,
      label: "上传",
      value: upScaled.value,
      unit: upScaled.unit,
      status: "ok",
    },
    {
      id: TRANSMISSION_DOWNLOADING_COUNT_METRIC_ID,
      label: "下载中",
      value: Math.trunc(downloadingCount),
      status: "ok",
    },
    {
      id: TRANSMISSION_SEEDING_COUNT_METRIC_ID,
      label: "做种中",
      value: Math.trunc(seedingCount),
      status: "ok",
    },
  ];
}

export async function fetchTransmissionMetrics(
  baseUrl: string,
  auth: TransmissionAuth,
  deps: TransmissionFetchDeps = {},
): Promise<Metric[]> {
  // 共用一次会话头：先 session-stats，再 torrent-get
  let sessionId: string | undefined;

  const runWithSession = async (
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await transmissionRpc(
        baseUrl,
        auth,
        method,
        args,
        deps,
        sessionId,
      );
      if (result.status === 409) {
        if (result.sessionId === null || result.sessionId.length === 0) {
          throw new AdapterLocalError(SESSION_ID_FAIL);
        }
        sessionId = result.sessionId;
        continue;
      }
      if (result.status < 200 || result.status >= 300 || result.body === null) {
        throw new AdapterLocalError(RPC_FAIL);
      }
      if (result.sessionId !== null && result.sessionId.length > 0) {
        sessionId = result.sessionId;
      }
      return result.body;
    }
    throw new AdapterLocalError(SESSION_ID_FAIL);
  };

  const statsBody = await runWithSession("session-stats", {});
  const rates = parseSessionStats(statsBody);
  const torrentsBody = await runWithSession("torrent-get", {
    fields: ["status"],
  });
  const counts = countTransmissionTorrents(torrentsBody);
  return buildTransmissionMetrics(
    rates.downloadBps,
    rates.uploadBps,
    counts.downloading,
    counts.seeding,
  );
}

function readAuth(secrets: AdapterRunInput["secrets"]): TransmissionAuth {
  const username = secrets["username"];
  const password = secrets["password"];
  const auth: TransmissionAuth = {};
  if (typeof username === "string" && username.length > 0) {
    auth.username = username;
  }
  if (typeof password === "string") {
    auth.password = password;
  }
  return auth;
}

async function runTransmission(
  input: AdapterRunInput,
): Promise<ServiceWidgetResult> {
  try {
    const auth = readAuth(input.secrets);
    const metrics = await fetchTransmissionMetrics(input.url, auth);
    return parseServiceWidgetResult({
      ok: true,
      metrics,
    });
  } catch (err) {
    return parseServiceWidgetResult({
      ok: false,
      error: toLocalErrorMessage(err, "Transmission 请求失败"),
    });
  }
}

export const transmissionAdapter: ServiceWidgetAdapter = {
  type: "transmission",
  run: runTransmission,
};
