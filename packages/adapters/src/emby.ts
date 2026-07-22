/** Emby 服务组件适配器。 - 仅使用 X-Emby-Token 请求头（不用查询参数） - Sessions：正在播放；Items/Counts：媒体库数量 - API key 不得进入结果或错误 */
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
export const EMBY_MOVIES_METRIC_ID = "movies" as const;
export const EMBY_SERIES_METRIC_ID = "series" as const;
export const EMBY_EPISODES_METRIC_ID = "episodes" as const;
export const EMBY_SONGS_METRIC_ID = "songs" as const;

export const EMBY_SESSION_SUMMARY_LIMIT = 5 as const;

const MISSING_KEY = "Emby 缺少 API 密钥配置";
const SESSIONS_FAIL = "获取 Emby 会话失败";
const SESSIONS_TIMEOUT = "获取 Emby 会话超时";
const SESSIONS_NETWORK = "无法连接 Emby 会话接口";
const SESSIONS_BAD_JSON = "Emby 会话响应不是有效 JSON";
const COUNTS_FAIL = "获取 Emby 媒体数量失败";
const COUNTS_TIMEOUT = "获取 Emby 媒体数量超时";
const COUNTS_NETWORK = "无法连接 Emby 媒体数量接口";
const COUNTS_BAD_JSON = "Emby 媒体数量响应不是有效 JSON";
const COUNTS_BAD_FIELDS = "Emby 媒体数量响应缺少计数字段";

const COUNT_FIELD_DEFS = [
  {
    id: EMBY_MOVIES_METRIC_ID,
    label: "电影",
    keys: ["MovieCount", "movieCount"] as const,
    field: "movies",
  },
  {
    id: EMBY_SERIES_METRIC_ID,
    label: "剧集",
    keys: ["SeriesCount", "seriesCount"] as const,
    field: "series",
  },
  {
    id: EMBY_EPISODES_METRIC_ID,
    label: "集数",
    keys: ["EpisodeCount", "episodeCount"] as const,
    field: "episodes",
  },
  {
    id: EMBY_SONGS_METRIC_ID,
    label: "歌曲",
    keys: ["SongCount", "songCount"] as const,
    field: "songs",
  },
] as const;

export type EmbyFetchDeps = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export type EmbyWidgetOptions = {
  enableBlocks: boolean;
  enableNowPlaying: boolean;
  enableUser: boolean;
  showEpisodeNumber: boolean;
  /** 限制媒体数量展示字段；空 = 全部 */
  fields: readonly string[];
};

function asBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

export function parseEmbyOptions(options: unknown): EmbyWidgetOptions {
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

  return {
    // 与官方一致：blocks 默认关；正在播放默认开
    enableBlocks: asBoolean(record["enableBlocks"], false),
    enableNowPlaying: asBoolean(record["enableNowPlaying"], true),
    enableUser: asBoolean(record["enableUser"], false),
    showEpisodeNumber: asBoolean(record["showEpisodeNumber"], false),
    fields,
  };
}

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

function formatSeasonEpisode(season: number, episode: number): string {
  const s = String(Math.trunc(season)).padStart(2, "0");
  const e = String(Math.trunc(episode)).padStart(2, "0");
  return `S${s} · E${e}`;
}

function computeProgress(
  playState: Record<string, unknown> | null,
  nowPlaying: Record<string, unknown>,
): number | undefined {
  const position = coerceNonNegNumber(playState?.["PositionTicks"]);
  let runtime = coerceNonNegNumber(nowPlaying["RunTimeTicks"]);
  if (runtime === null || runtime === 0) {
    const program = nowPlaying["CurrentProgram"];
    if (
      program !== null &&
      program !== undefined &&
      typeof program === "object" &&
      !Array.isArray(program)
    ) {
      runtime = coerceNonNegNumber(
        (program as Record<string, unknown>)["RunTimeTicks"],
      );
    }
  }
  if (position === null || runtime === null || runtime <= 0) {
    return undefined;
  }
  const pct = (position / runtime) * 100;
  if (!Number.isFinite(pct)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

export function sessionToSummary(
  session: unknown,
  index: number,
  options: Pick<EmbyWidgetOptions, "enableUser" | "showEpisodeNumber"> = {
    enableUser: true,
    showEpisodeNumber: true,
  },
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

  const playState =
    record["PlayState"] !== null &&
    record["PlayState"] !== undefined &&
    typeof record["PlayState"] === "object" &&
    !Array.isArray(record["PlayState"])
      ? (record["PlayState"] as Record<string, unknown>)
      : null;

  const id =
    asNonEmptyString(record["Id"]) ??
    asNonEmptyString(record["id"]) ??
    asNonEmptyString(nowPlaying["Id"]) ??
    `session-${index + 1}`;

  const seriesName = asNonEmptyString(nowPlaying["SeriesName"]);
  const itemName = asNonEmptyString(nowPlaying["Name"]);
  const album = asNonEmptyString(nowPlaying["Album"]);
  const albumArtist = asNonEmptyString(nowPlaying["AlbumArtist"]);

  let title: string;
  if (seriesName !== undefined) {
    title = seriesName;
  } else if (albumArtist !== undefined && itemName !== undefined) {
    title = `${albumArtist} - ${itemName}`;
  } else if (itemName !== undefined) {
    title = itemName;
  } else if (album !== undefined) {
    title = album;
  } else {
    title = "未知媒体";
  }

  let episode: string | undefined;
  if (seriesName !== undefined) {
    const season = nowPlaying["ParentIndexNumber"];
    const epNum = nowPlaying["IndexNumber"];
    const seasonN =
      typeof season === "number" && Number.isFinite(season)
        ? season
        : undefined;
    const epN =
      typeof epNum === "number" && Number.isFinite(epNum) ? epNum : undefined;
    const epName = itemName;
    if (options.showEpisodeNumber && seasonN !== undefined && epN !== undefined) {
      const se = formatSeasonEpisode(seasonN, epN);
      episode = epName !== undefined ? `${se} ${epName}` : se;
    } else if (epName !== undefined) {
      episode = epName;
    }
  } else {
    episode = asNonEmptyString(nowPlaying["EpisodeTitle"]);
  }

  const summary: EmbySessionSummary = { id, title };

  if (options.enableUser) {
    const user =
      asNonEmptyString(record["UserName"]) ??
      asNonEmptyString(record["user"]);
    if (user !== undefined) {
      summary.user = user;
    }
  }

  if (episode !== undefined) {
    summary.episode = episode;
  }

  const progress = computeProgress(playState, nowPlaying);
  if (progress !== undefined) {
    summary.progress = progress;
  }

  return summary;
}

export function convertEmbySessions(
  data: unknown,
  options: Pick<
    EmbyWidgetOptions,
    "enableUser" | "showEpisodeNumber"
  > = { enableUser: true, showEpisodeNumber: true },
): {
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
    .map((session, index) => sessionToSummary(session, index, options));

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

export function convertEmbyCounts(
  data: unknown,
  fields: readonly string[] = [],
): Metric[] {
  if (
    data === null ||
    data === undefined ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    throw new AdapterLocalError(COUNTS_BAD_FIELDS);
  }
  const record = data as Record<string, unknown>;
  const allow =
    fields.length === 0 ? null : new Set(fields.map((f) => f.toLowerCase()));

  const metrics: Metric[] = [];
  for (const def of COUNT_FIELD_DEFS) {
    if (allow !== null && !allow.has(def.field)) {
      continue;
    }
    let value: number | null = null;
    for (const key of def.keys) {
      value = coerceNonNegNumber(record[key]);
      if (value !== null) {
        break;
      }
    }
    if (value === null) {
      // 字段缺失时记 0，避免整卡失败（部分 Emby 版本可能缺 SongCount）
      value = 0;
    }
    metrics.push({
      id: def.id,
      label: def.label,
      value: Math.trunc(value),
      status: "ok",
    });
  }

  if (metrics.length === 0) {
    throw new AdapterLocalError(COUNTS_BAD_FIELDS);
  }
  return metrics;
}

async function embyGet(
  baseUrl: string,
  path: string,
  apiKey: string,
  deps: EmbyFetchDeps,
  messages: { fail: string; timeout: string; network: string; badJson: string },
): Promise<unknown> {
  const url = joinBaseUrl(baseUrl, path);
  const requestOptions: Parameters<typeof adapterFetch>[1] = {
    method: "GET",
    headers: {
      "X-Emby-Token": apiKey,
      Accept: "application/json",
    },
    timeoutMessage: messages.timeout,
    networkMessage: messages.network,
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
      : new AdapterLocalError(messages.network);
  }

  if (!response.ok) {
    throw new AdapterLocalError(messages.fail);
  }

  return readJsonBody(response, messages.badJson);
}

export async function fetchEmbySessions(
  baseUrl: string,
  apiKey: string,
  deps: EmbyFetchDeps = {},
  options: Pick<
    EmbyWidgetOptions,
    "enableUser" | "showEpisodeNumber"
  > = { enableUser: true, showEpisodeNumber: true },
): Promise<{ metrics: Metric[]; sessions: EmbySessionSummary[] }> {
  const json = await embyGet(baseUrl, "/Sessions", apiKey, deps, {
    fail: SESSIONS_FAIL,
    timeout: SESSIONS_TIMEOUT,
    network: SESSIONS_NETWORK,
    badJson: SESSIONS_BAD_JSON,
  });
  return convertEmbySessions(json, options);
}

export async function fetchEmbyCounts(
  baseUrl: string,
  apiKey: string,
  deps: EmbyFetchDeps = {},
  fields: readonly string[] = [],
): Promise<Metric[]> {
  const json = await embyGet(baseUrl, "/Items/Counts", apiKey, deps, {
    fail: COUNTS_FAIL,
    timeout: COUNTS_TIMEOUT,
    network: COUNTS_NETWORK,
    badJson: COUNTS_BAD_JSON,
  });
  return convertEmbyCounts(json, fields);
}

export async function fetchEmbyWidgetData(
  baseUrl: string,
  apiKey: string,
  options: EmbyWidgetOptions,
  deps: EmbyFetchDeps = {},
): Promise<{ metrics: Metric[]; sessions?: EmbySessionSummary[] }> {
  const tasks: Promise<void>[] = [];
  let countMetrics: Metric[] = [];
  let sessionMetrics: Metric[] = [];
  let sessions: EmbySessionSummary[] | undefined;

  if (options.enableBlocks) {
    tasks.push(
      fetchEmbyCounts(baseUrl, apiKey, deps, options.fields).then((m) => {
        countMetrics = m;
      }),
    );
  }

  if (options.enableNowPlaying) {
    tasks.push(
      fetchEmbySessions(baseUrl, apiKey, deps, {
        enableUser: options.enableUser,
        showEpisodeNumber: options.showEpisodeNumber,
      }).then((result) => {
        sessionMetrics = result.metrics;
        sessions = result.sessions;
      }),
    );
  }

  if (tasks.length === 0) {
    // 全部关闭时返回空指标，避免无意义请求
    return { metrics: [] };
  }

  await Promise.all(tasks);

  return {
    metrics: [...countMetrics, ...sessionMetrics],
    ...(sessions !== undefined ? { sessions } : {}),
  };
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

    const options = parseEmbyOptions(input.options);
    const { metrics, sessions } = await fetchEmbyWidgetData(
      input.url,
      apiKey,
      options,
    );

    const result: {
      ok: true;
      metrics: Metric[];
      sessions?: EmbySessionSummary[];
    } = {
      ok: true,
      metrics,
    };
    if (sessions !== undefined) {
      result.sessions = sessions;
    }
    return parseServiceWidgetResult(result);
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
