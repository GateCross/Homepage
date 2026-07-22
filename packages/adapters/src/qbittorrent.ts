/** 一自动缩放单位体系） SID、账号、密码不得进入结果、错误消息或日志。 */
import type { Metric, ServiceWidgetResult } from "@homepage/domain";

import { scaleByteRate } from "./format.js";
import {
  AdapterLocalError,
  adapterFetch,
  getSetCookieLines,
  joinBaseUrl,
  readJsonBody,
  toLocalErrorMessage,
  type FetchLike,
} from "./http.js";
import type { AdapterRunInput, ServiceWidgetAdapter } from "./types.js";
import { parseServiceWidgetResult } from "./validate.js";

export const QBITTORRENT_DOWNLOAD_METRIC_ID = "download" as const;
export const QBITTORRENT_UPLOAD_METRIC_ID = "upload" as const;
export const QBITTORRENT_DOWNLOADING_COUNT_METRIC_ID = "downloading" as const;
export const QBITTORRENT_SEEDING_COUNT_METRIC_ID = "seeding" as const;

const LOGIN_FAIL = "qBittorrent 登录失败";
const LOGIN_NO_SID = "qBittorrent 登录未返回有效会话";
const LOGIN_TIMEOUT = "qBittorrent 登录超时";
const LOGIN_NETWORK = "无法连接 qBittorrent 登录接口";
const TRANSFER_FAIL = "获取 qBittorrent 传输信息失败";
const TRANSFER_TIMEOUT = "获取 qBittorrent 传输信息超时";
const TRANSFER_NETWORK = "无法连接 qBittorrent 传输信息接口";
const TRANSFER_BAD_JSON = "qBittorrent 传输信息不是有效 JSON";
const TRANSFER_BAD_FIELDS = "qBittorrent 传输信息缺少速率字段";
const TORRENTS_FAIL = "获取 qBittorrent 种子列表失败";
const TORRENTS_TIMEOUT = "获取 qBittorrent 种子列表超时";
const TORRENTS_NETWORK = "无法连接 qBittorrent 种子列表接口";
const TORRENTS_BAD_JSON = "qBittorrent 种子列表不是有效 JSON";
const MISSING_CREDENTIALS = "qBittorrent 缺少用户名或密码配置";

/** 下载中（含卡住/元数据/强制下载等） */
const QB_DOWNLOADING_STATES = new Set([
  "downloading",
  "stalledDL",
  "metaDL",
  "forcedDL",
  "allocating",
  "checkingDL",
  "queuedDL",
]);

/** 做种中（含卡住/强制/排队上传等） */
const QB_SEEDING_STATES = new Set([
  "uploading",
  "stalledUP",
  "forcedUP",
  "queuedUP",
  "checkingUP",
]);

export type QbittorrentAuth = {
  username: string;
  password: string;
};

export type QbittorrentFetchDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export function extractSidFromSetCookieLines(lines: readonly string[]): string | null {
  for (const line of lines) {
    // 典型：SID=xxxx; Path=/; HttpOnly
    const match = /(?:^|,\s*)SID=([^;,\s]+)/i.exec(line);
    if (match !== null && match[1] !== undefined && match[1].length > 0) {
      return match[1];
    }
  }
  // 兼容无逗号分隔、仅 name=value 前缀
  for (const line of lines) {
    const parts = line.split(";");
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.toLowerCase().startsWith("sid=")) {
        const value = trimmed.slice(4).trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return null;
}

export async function loginQbittorrent(
  baseUrl: string,
  auth: QbittorrentAuth,
  deps: QbittorrentFetchDeps = {},
): Promise<string> {
  const url = joinBaseUrl(baseUrl, "/api/v2/auth/login");
  const body = new URLSearchParams({
    username: auth.username,
    password: auth.password,
  }).toString();

  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    timeoutMessage: LOGIN_TIMEOUT,
    networkMessage: LOGIN_NETWORK,
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
      : new AdapterLocalError(LOGIN_NETWORK);
  }

  // 登录接口成功时常为 200 且 body 为 "Ok."；失败可能 403 或 body "Fails."
  if (!response.ok) {
    throw new AdapterLocalError(LOGIN_FAIL);
  }

  // 部分版本在 body 标明 Fails.，即使 HTTP 200
  try {
    const text = (await response.clone().text()).trim();
    if (/^fails\.?$/i.test(text)) {
      throw new AdapterLocalError(LOGIN_FAIL);
    }
  } catch (err) {
    if (err instanceof AdapterLocalError) {
      throw err;
    }
    // 读 body 失败不阻塞 SID 解析
  }

  const sid = extractSidFromSetCookieLines(getSetCookieLines(response));
  if (sid === null || sid.length === 0) {
    throw new AdapterLocalError(LOGIN_NO_SID);
  }
  return sid;
}

export async function fetchTransferInfoRaw(
  baseUrl: string,
  sid: string,
  deps: QbittorrentFetchDeps = {},
): Promise<Response> {
  const url = joinBaseUrl(baseUrl, "/api/v2/transfer/info");
  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "GET",
    headers: {
      Cookie: `SID=${sid}`,
    },
    timeoutMessage: TRANSFER_TIMEOUT,
    networkMessage: TRANSFER_NETWORK,
  };
  if (deps.fetchImpl !== undefined) {
    requestOptions.fetchImpl = deps.fetchImpl;
  }
  if (deps.timeoutMs !== undefined) {
    requestOptions.timeoutMs = deps.timeoutMs;
  }
  return adapterFetch(url, requestOptions);
}

export async function fetchTorrentsInfoRaw(
  baseUrl: string,
  sid: string,
  deps: QbittorrentFetchDeps = {},
): Promise<Response> {
  const url = joinBaseUrl(baseUrl, "/api/v2/torrents/info");
  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "GET",
    headers: {
      Cookie: `SID=${sid}`,
    },
    timeoutMessage: TORRENTS_TIMEOUT,
    networkMessage: TORRENTS_NETWORK,
  };
  if (deps.fetchImpl !== undefined) {
    requestOptions.fetchImpl = deps.fetchImpl;
  }
  if (deps.timeoutMs !== undefined) {
    requestOptions.timeoutMs = deps.timeoutMs;
  }
  return adapterFetch(url, requestOptions);
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

export function transferInfoToRates(data: unknown): {
  downloadBps: number;
  uploadBps: number;
} {
  if (
    data === null ||
    data === undefined ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    throw new AdapterLocalError(TRANSFER_BAD_FIELDS);
  }
  const record = data as Record<string, unknown>;
  const dlN = coerceNonNegNumber(record["dl_info_speed"]);
  const upN = coerceNonNegNumber(record["up_info_speed"]);
  if (dlN === null || upN === null) {
    throw new AdapterLocalError(TRANSFER_BAD_FIELDS);
  }
  return { downloadBps: dlN, uploadBps: upN };
}

/** @deprecated 优先使用 transferInfoToRates + buildQbittorrentMetrics */
export function transferInfoToMetrics(data: unknown): Metric[] {
  const rates = transferInfoToRates(data);
  return buildQbittorrentMetrics(rates.downloadBps, rates.uploadBps, 0, 0);
}

export function countTorrentStates(data: unknown): {
  downloading: number;
  seeding: number;
} {
  if (!Array.isArray(data)) {
    throw new AdapterLocalError(TORRENTS_BAD_JSON);
  }
  let downloading = 0;
  let seeding = 0;
  for (const item of data) {
    if (
      item === null ||
      item === undefined ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      continue;
    }
    const state = (item as Record<string, unknown>)["state"];
    if (typeof state !== "string") {
      continue;
    }
    if (QB_DOWNLOADING_STATES.has(state)) {
      downloading += 1;
    } else if (QB_SEEDING_STATES.has(state)) {
      seeding += 1;
    }
  }
  return { downloading, seeding };
}

export function buildQbittorrentMetrics(
  downloadBps: number,
  uploadBps: number,
  downloadingCount: number,
  seedingCount: number,
): Metric[] {
  const dlScaled = scaleByteRate(downloadBps);
  const upScaled = scaleByteRate(uploadBps);
  return [
    {
      id: QBITTORRENT_DOWNLOAD_METRIC_ID,
      label: "下载",
      value: dlScaled.value,
      unit: dlScaled.unit,
      status: "ok",
    },
    {
      id: QBITTORRENT_UPLOAD_METRIC_ID,
      label: "上传",
      value: upScaled.value,
      unit: upScaled.unit,
      status: "ok",
    },
    {
      id: QBITTORRENT_DOWNLOADING_COUNT_METRIC_ID,
      label: "下载中",
      value: Math.trunc(downloadingCount),
      status: "ok",
    },
    {
      id: QBITTORRENT_SEEDING_COUNT_METRIC_ID,
      label: "做种中",
      value: Math.trunc(seedingCount),
      status: "ok",
    },
  ];
}

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

async function withQbittorrentSession<T>(
  baseUrl: string,
  auth: QbittorrentAuth,
  deps: QbittorrentFetchDeps,
  run: (sid: string) => Promise<{ status: number; value?: T }>,
  failMessage: string,
): Promise<T> {
  let sid = await loginQbittorrent(baseUrl, auth, deps);
  let relogged = false;

  for (;;) {
    let result: { status: number; value?: T };
    try {
      result = await run(sid);
    } catch (err) {
      throw err instanceof AdapterLocalError ? err : new AdapterLocalError(failMessage);
    }

    if (isAuthFailureStatus(result.status)) {
      if (relogged) {
        throw new AdapterLocalError(LOGIN_FAIL);
      }
      relogged = true;
      sid = await loginQbittorrent(baseUrl, auth, deps);
      continue;
    }

    if (result.status < 200 || result.status >= 300 || result.value === undefined) {
      throw new AdapterLocalError(failMessage);
    }
    return result.value;
  }
}

export async function fetchQbittorrentTransferMetrics(
  baseUrl: string,
  auth: QbittorrentAuth,
  deps: QbittorrentFetchDeps = {},
): Promise<Metric[]> {
  return withQbittorrentSession(
    baseUrl,
    auth,
    deps,
    async (sid) => {
      const [transferRes, torrentsRes] = await Promise.all([
        fetchTransferInfoRaw(baseUrl, sid, deps),
        fetchTorrentsInfoRaw(baseUrl, sid, deps),
      ]);

      // 任一 401/403 都触发重登
      if (
        isAuthFailureStatus(transferRes.status) ||
        isAuthFailureStatus(torrentsRes.status)
      ) {
        return {
          status: isAuthFailureStatus(transferRes.status)
            ? transferRes.status
            : torrentsRes.status,
        };
      }

      if (!transferRes.ok) {
        return { status: transferRes.status };
      }
      if (!torrentsRes.ok) {
        throw new AdapterLocalError(TORRENTS_FAIL);
      }

      const transferJson = await readJsonBody(transferRes, TRANSFER_BAD_JSON);
      const torrentsJson = await readJsonBody(torrentsRes, TORRENTS_BAD_JSON);
      const rates = transferInfoToRates(transferJson);
      const counts = countTorrentStates(torrentsJson);
      return {
        status: 200,
        value: buildQbittorrentMetrics(
          rates.downloadBps,
          rates.uploadBps,
          counts.downloading,
          counts.seeding,
        ),
      };
    },
    TRANSFER_FAIL,
  );
}

function readAuth(secrets: AdapterRunInput["secrets"]): QbittorrentAuth | null {
  const username = secrets["username"];
  const password = secrets["password"];
  if (
    typeof username !== "string" ||
    username.length === 0 ||
    typeof password !== "string" ||
    password.length === 0
  ) {
    return null;
  }
  return { username, password };
}

async function runQbittorrent(
  input: AdapterRunInput,
): Promise<ServiceWidgetResult> {
  try {
    const auth = readAuth(input.secrets);
    if (auth === null) {
      return parseServiceWidgetResult({
        ok: false,
        error: MISSING_CREDENTIALS,
      });
    }

    const metrics = await fetchQbittorrentTransferMetrics(input.url, auth);
    return parseServiceWidgetResult({
      ok: true,
      metrics,
    });
  } catch (err) {
    return parseServiceWidgetResult({
      ok: false,
      error: toLocalErrorMessage(err, "qBittorrent 请求失败"),
    });
  }
}

export const qbittorrentAdapter: ServiceWidgetAdapter = {
  type: "qbittorrent",
  run: runQbittorrent,
};
