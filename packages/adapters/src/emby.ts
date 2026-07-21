/** Emby 服务组件适配器（）。 - 仅使用 X-Emby-Token 请求头（不用查询参数） - 仅调用 Sessions API，筛选正在播放，输出总数 + 最多 5 条摘要 - API key 不得进入结果或错误 */
import type {
  EmbySessionSummary,
  Metric,
  ServiceWidgetResult,
} from "@homepage/domain";

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

export const EMBY_SESSIONS_TOTAL_METRIC_ID = "sessions_total" as const;

export const EMBY_SESSION_SUMMARY_LIMIT = 5 as const;

const MISSING_KEY = "Emby 缺少 API 密钥配置";
const SESSIONS_FAIL = "获取 Emby 会话失败";
const SESSIONS_TIMEOUT = "获取 Emby 会话超时";
const SESSIONS_NETWORK = "无法连接 Emby 会话接口";
const SESSIONS_BAD_JSON = "Emby 会话响应不是有效 JSON";

export type EmbyFetchDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export function readEmbyApiKey(
  secrets: AdapterRunInput["secrets"],
): string | null {
  const key = secrets["key"];
  if (typeof key === "string" && key.length > 0) {
    return key;
  }
  const token = secrets["token"];
  if (typeof token === "string" && token.length > 0) {
    return token;
  }
  return null;
}

export function isNowPlayingSession(session: unknown): boolean {
  if (
    session === null ||
    session === undefined ||
    typeof session !== "object" ||
    Array.isArray(session)
  ) {
    return false;
  }
  const item = (session as Record<string, unknown>)["NowPlayingItem"];
  if (item === null || item === undefined) {
    return false;
  }
  if (typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  return true;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function sessionToSummary(
  session: unknown,
  index: number,
): EmbySessionSummary {
  const record =
    session !== null &&
    session !== undefined &&
    typeof session === "object" &&
    !Array.isArray(session)
      ? (session as Record<string, unknown>)
      : {};

  const nowPlaying =
    record["NowPlayingItem"] !== null &&
    record["NowPlayingItem"] !== undefined &&
    typeof record["NowPlayingItem"] === "object" &&
    !Array.isArray(record["NowPlayingItem"])
      ? (record["NowPlayingItem"] as Record<string, unknown>)
      : {};

  const id =
    asNonEmptyString(record["Id"]) ??
    asNonEmptyString(record["id"]) ??
    asNonEmptyString(nowPlaying["Id"]) ??
    `session-${index + 1}`;

  const seriesName = asNonEmptyString(nowPlaying["SeriesName"]);
  const episodeName = asNonEmptyString(nowPlaying["Name"]);
  const itemName = asNonEmptyString(nowPlaying["Name"]);
  const album = asNonEmptyString(nowPlaying["Album"]);

  let title: string;
  if (seriesName !== undefined) {
    title = seriesName;
  } else if (itemName !== undefined) {
    title = itemName;
  } else if (album !== undefined) {
    title = album;
  } else {
    title = "未知媒体";
  }

  const user =
    asNonEmptyString(record["UserName"]) ??
    asNonEmptyString(record["user"]);

  let episode: string | undefined;
  if (seriesName !== undefined && episodeName !== undefined) {
    const season = nowPlaying["ParentIndexNumber"];
    const epNum = nowPlaying["IndexNumber"];
    const seasonN =
      typeof season === "number" && Number.isFinite(season)
        ? season
        : undefined;
    const epN =
      typeof epNum === "number" && Number.isFinite(epNum) ? epNum : undefined;
    if (seasonN !== undefined && epN !== undefined) {
      episode = `S${seasonN}E${epN} ${episodeName}`;
    } else {
      episode = episodeName;
    }
  } else {
    episode = asNonEmptyString(nowPlaying["EpisodeTitle"]);
  }

  const summary: EmbySessionSummary = { id, title };
  if (user !== undefined) {
    summary.user = user;
  }
  if (episode !== undefined) {
    summary.episode = episode;
  }
  return summary;
}

export function convertEmbySessions(data: unknown): {
  metrics: Metric[];
  sessions: EmbySessionSummary[];
} {
  if (!Array.isArray(data)) {
    throw new AdapterLocalError(SESSIONS_BAD_JSON);
  }

  const playing = data.filter(isNowPlayingSession);
  const total = playing.length;
  const sessions = playing
    .slice(0, EMBY_SESSION_SUMMARY_LIMIT)
    .map((session, index) => sessionToSummary(session, index));

  const metrics: Metric[] = [
    {
      id: EMBY_SESSIONS_TOTAL_METRIC_ID,
      label: "正在播放",
      value: total,
      status: "ok",
    },
  ];

  return { metrics, sessions };
}

export async function fetchEmbySessions(
  baseUrl: string,
  apiKey: string,
  deps: EmbyFetchDeps = {},
): Promise<{ metrics: Metric[]; sessions: EmbySessionSummary[] }> {
  const url = joinBaseUrl(baseUrl, "/Sessions");
  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "GET",
    headers: {
      "X-Emby-Token": apiKey,
      Accept: "application/json",
    },
    timeoutMessage: SESSIONS_TIMEOUT,
    networkMessage: SESSIONS_NETWORK,
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
      : new AdapterLocalError(SESSIONS_NETWORK);
  }

  if (!response.ok) {
    throw new AdapterLocalError(SESSIONS_FAIL);
  }

  const json = await readJsonBody(response, SESSIONS_BAD_JSON);
  return convertEmbySessions(json);
}

async function runEmby(input: AdapterRunInput): Promise<ServiceWidgetResult> {
  try {
    const apiKey = readEmbyApiKey(input.secrets);
    if (apiKey === null) {
      return parseServiceWidgetResult({
        ok: false,
        error: MISSING_KEY,
      });
    }

    const { metrics, sessions } = await fetchEmbySessions(input.url, apiKey);
    return parseServiceWidgetResult({
      ok: true,
      metrics,
      sessions,
    });
  } catch (err) {
    return parseServiceWidgetResult({
      ok: false,
      error: toLocalErrorMessage(err, "Emby 请求失败"),
    });
  }
}

export const embyAdapter: ServiceWidgetAdapter = {
  type: "emby",
  run: runEmby,
};
