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

const LOGIN_FAIL = "qBittorrent 登录失败";
const LOGIN_NO_SID = "qBittorrent 登录未返回有效会话";
const LOGIN_TIMEOUT = "qBittorrent 登录超时";
const LOGIN_NETWORK = "无法连接 qBittorrent 登录接口";
const TRANSFER_FAIL = "获取 qBittorrent 传输信息失败";
const TRANSFER_TIMEOUT = "获取 qBittorrent 传输信息超时";
const TRANSFER_NETWORK = "无法连接 qBittorrent 传输信息接口";
const TRANSFER_BAD_JSON = "qBittorrent 传输信息不是有效 JSON";
const TRANSFER_BAD_FIELDS = "qBittorrent 传输信息缺少速率字段";
const MISSING_CREDENTIALS = "qBittorrent 缺少用户名或密码配置";

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

export function transferInfoToMetrics(data: unknown): Metric[] {
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    throw new AdapterLocalError(TRANSFER_BAD_FIELDS);
  }
  const record = data as Record<string, unknown>;
  const dl = record["dl_info_speed"];
  const up = record["up_info_speed"];
  if (typeof dl !== "number" || !Number.isFinite(dl) || typeof up !== "number" || !Number.isFinite(up)) {
    // 允许字符串数字
    const dlN =
      typeof dl === "number" && Number.isFinite(dl)
        ? dl
        : typeof dl === "string" && Number.isFinite(Number(dl))
          ? Number(dl)
          : null;
    const upN =
      typeof up === "number" && Number.isFinite(up)
        ? up
        : typeof up === "string" && Number.isFinite(Number(up))
          ? Number(up)
          : null;
    if (dlN === null || upN === null) {
      throw new AdapterLocalError(TRANSFER_BAD_FIELDS);
    }
    return buildRateMetrics(dlN, upN);
  }
  return buildRateMetrics(dl, up);
}

function buildRateMetrics(downloadBps: number, uploadBps: number): Metric[] {
  const dlScaled = scaleByteRate(downloadBps);
  const upScaled = scaleByteRate(uploadBps);
  return [
    {
      id: QBITTORRENT_DOWNLOAD_METRIC_ID,
      label: "下载速率",
      value: dlScaled.value,
      unit: dlScaled.unit,
      status: "ok",
    },
    {
      id: QBITTORRENT_UPLOAD_METRIC_ID,
      label: "上传速率",
      value: upScaled.value,
      unit: upScaled.unit,
      status: "ok",
    },
  ];
}

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export async function fetchQbittorrentTransferMetrics(
  baseUrl: string,
  auth: QbittorrentAuth,
  deps: QbittorrentFetchDeps = {},
): Promise<Metric[]> {
  let sid = await loginQbittorrent(baseUrl, auth, deps);
  let relogged = false;

  for (;;) {
    let response: Response;
    try {
      response = await fetchTransferInfoRaw(baseUrl, sid, deps);
    } catch (err) {
      throw err instanceof AdapterLocalError
        ? err
        : new AdapterLocalError(TRANSFER_NETWORK);
    }

    if (isAuthFailureStatus(response.status)) {
      if (relogged) {
        throw new AdapterLocalError(LOGIN_FAIL);
      }
      relogged = true;
      sid = await loginQbittorrent(baseUrl, auth, deps);
      continue;
    }

    if (!response.ok) {
      throw new AdapterLocalError(TRANSFER_FAIL);
    }

    const json = await readJsonBody(response, TRANSFER_BAD_JSON);
    return transferInfoToMetrics(json);
  }
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
