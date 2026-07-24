import http from "node:http";
import https from "node:https";
import type { DockerEndpoint } from "@homepage/config";
import {
  clampPercent,
  type DockerContainerSummary,
  type DockerHealth,
  type DockerResourceStats,
  type DockerStatusResponse,
} from "@homepage/domain";

export const DOCKER_TIMEOUT_MS = 10_000;
/**
 * one-shot stats 为即时快照，通常远低于 inspect 超时；
 * 仍保留上限，避免远端 Docker 卡住拖死批量。
 */
export const DOCKER_STATS_TIMEOUT_MS = 10_000;

/** 进程内上一拍 CPU 计数保留多久；超过则丢弃（冷启动后首包可能无 cpu%） */
export const DOCKER_CPU_SAMPLE_MAX_AGE_MS = 60_000;

/**
 * 无上一拍时，两次 one-shot 之间的间隔，用于首包也能算出 cpu%。
 * 远小于 Docker stream=0 的服务端采样等待（约 1s）。
 */
export const DOCKER_CPU_SEED_GAP_MS = 200;

const ALLOWED_PATH_PREFIX = "/containers/";
const ALLOWED_INSPECT_SUFFIX = "/json";
/** one-shot：Engine 立即返回当前计数，不在服务端等采样间隔（约 1s） */
const ALLOWED_STATS_SUFFIX = "/stats?stream=0&one-shot=1";
const LIST_CONTAINERS_PATH = "/containers/json";
const LIST_CONTAINERS_PATH_ALL = "/containers/json?all=true";

/** 用于跨轮询计算 CPU% 的计数快照（非 API 契约） */
export type DockerCpuCounterSample = {
  totalUsage: number;
  systemUsage: number;
  onlineCpus: number;
  atMs: number;
};

export type DockerClientRequest = {
  method: "GET";
  path: string;
};

export type DockerClientResponse = {
  statusCode: number;
  body: string;
};

export type DockerTransport = {
  request: (req: DockerClientRequest) => Promise<DockerClientResponse>;
};

export type DockerClient = {
  /** 查询容器状态；运行中附带 CPU/内存占用；不得提供写操作 */
  inspectContainer: (containerNameOrId: string) => Promise<DockerStatusResponse>;
  /** 仅拉资源占用（供 full 路径复用 lite 状态时跳过 inspect） */
  containerStats: (containerNameOrId: string) => Promise<DockerResourceStats>;
  /** 列出容器摘要（只读发现） */
  listContainers: () => Promise<DockerContainerSummary[]>;
};

export class DockerClientError extends Error {
  readonly localMessage: string;
  readonly kind: "timeout" | "unreachable" | "not_found" | "invalid" | "other";

  constructor(
    localMessage: string,
    kind: "timeout" | "unreachable" | "not_found" | "invalid" | "other",
  ) {
    super(localMessage);
    this.name = "DockerClientError";
    this.localMessage = localMessage;
    this.kind = kind;
  }
}

export function encodeDockerPathSegment(name: string): string {
  return encodeURIComponent(name);
}

export function buildInspectPath(containerNameOrId: string): string {
  const trimmed = containerNameOrId.trim();
  if (trimmed.length === 0) {
    throw new DockerClientError("容器名称无效", "invalid");
  }
  // 防止路径穿越：不允许 / 与 ..
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    // Docker 容器名本身不应含 /；仍编码后请求，由 API 返回 404
  }
  const encoded = encodeDockerPathSegment(trimmed);
  return `${ALLOWED_PATH_PREFIX}${encoded}${ALLOWED_INSPECT_SUFFIX}`;
}

export function buildStatsPath(containerNameOrId: string): string {
  const trimmed = containerNameOrId.trim();
  if (trimmed.length === 0) {
    throw new DockerClientError("容器名称无效", "invalid");
  }
  const encoded = encodeDockerPathSegment(trimmed);
  return `${ALLOWED_PATH_PREFIX}${encoded}${ALLOWED_STATS_SUFFIX}`;
}

function isAllowedListPath(path: string): boolean {
  return path === LIST_CONTAINERS_PATH || path === LIST_CONTAINERS_PATH_ALL;
}

function isAllowedStatsPath(path: string): boolean {
  if (!path.startsWith(ALLOWED_PATH_PREFIX)) {
    return false;
  }
  const q = path.indexOf("?");
  const pathOnly = q === -1 ? path : path.slice(0, q);
  // pathOnly = /containers/<id>/stats
  if (!pathOnly.endsWith("/stats")) {
    return false;
  }
  const middle = pathOnly.slice(
    ALLOWED_PATH_PREFIX.length,
    pathOnly.length - "/stats".length,
  );
  // middle 为容器 id（无斜杠）；禁止路径穿越
  if (middle.length === 0 || middle.includes("/")) {
    return false;
  }
  if (q === -1) {
    // 无 query 时 Docker 会 stream；本客户端禁止
    return false;
  }
  const params = new URLSearchParams(path.slice(q + 1));
  // 仅允许 stream / one-shot，且必须 stream=0（非流式）
  for (const key of params.keys()) {
    if (key !== "stream" && key !== "one-shot") {
      return false;
    }
  }
  if (params.get("stream") !== "0") {
    return false;
  }
  const oneShot = params.get("one-shot");
  if (oneShot !== null && oneShot !== "1" && oneShot !== "true") {
    return false;
  }
  return true;
}

function isAllowedContainerReadPath(path: string): boolean {
  if (!path.startsWith(ALLOWED_PATH_PREFIX)) {
    return false;
  }
  if (path.endsWith(ALLOWED_INSPECT_SUFFIX)) {
    const middle = path.slice(
      ALLOWED_PATH_PREFIX.length,
      path.length - ALLOWED_INSPECT_SUFFIX.length,
    );
    return middle.length > 0 && !middle.includes("/");
  }
  return isAllowedStatsPath(path);
}

export function assertReadonlyDockerRequest(req: DockerClientRequest): void {
  if (req.method !== "GET") {
    throw new DockerClientError("Docker 客户端仅允许只读查询", "invalid");
  }
  if (isAllowedListPath(req.path)) {
    return;
  }
  // 仅允许 /containers/<id>/json 与 /containers/<id>/stats?stream=0
  if (!isAllowedContainerReadPath(req.path)) {
    throw new DockerClientError("Docker 客户端拒绝非只读查询请求", "invalid");
  }
}

function truncateDetail(text: string, max = 80): string {
  const t = text.trim();
  if (t.length === 0) return t;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function readHealth(st: Record<string, unknown>): DockerHealth | undefined {
  const health = st["Health"];
  if (health === null || typeof health !== "object" || Array.isArray(health)) {
    return undefined;
  }
  const status = (health as Record<string, unknown>)["Status"];
  if (typeof status !== "string") return undefined;
  const s = status.trim().toLowerCase();
  if (s === "healthy" || s === "unhealthy" || s === "starting") {
    return s;
  }
  return undefined;
}

function withOptionalMeta(
  base: DockerStatusResponse,
  opts: { health?: DockerHealth | undefined; detail?: string | undefined },
): DockerStatusResponse {
  if (base.status === "unavailable") return base;
  const next = { ...base };
  if (opts.health !== undefined) next.health = opts.health;
  if (opts.detail !== undefined && opts.detail.length > 0) {
    next.detail = opts.detail;
  }
  return next;
}

export function mapInspectToStatus(payload: unknown): DockerStatusResponse {
  if (payload === null || typeof payload !== "object") {
    return { status: "unavailable", reason: "Docker 返回了异常结构" };
  }
  const root = payload as Record<string, unknown>;
  const state = root["State"];
  if (state === null || typeof state !== "object") {
    // 部分 API 可能把 Status 放在顶层
    const topStatus = root["Status"] ?? root["State"];
    if (typeof topStatus === "string") {
      return mapStatusString(topStatus);
    }
    return { status: "unavailable", reason: "Docker 返回了异常结构" };
  }
  const st = state as Record<string, unknown>;
  const statusText =
    typeof st["Status"] === "string" ? truncateDetail(st["Status"]) : undefined;
  const health = readHealth(st);
  const statusLower =
    typeof st["Status"] === "string"
      ? st["Status"].trim().toLowerCase()
      : "";

  // 瞬态优先于 Running 布尔
  if (st["Restarting"] === true || statusLower === "restarting") {
    return withOptionalMeta(
      { status: "restarting" },
      { health, detail: statusText },
    );
  }
  if (st["Paused"] === true || statusLower === "paused") {
    return withOptionalMeta(
      { status: "paused" },
      { health, detail: statusText },
    );
  }
  if (statusLower === "created" || statusLower === "removing") {
    return withOptionalMeta(
      { status: "starting" },
      { health, detail: statusText },
    );
  }

  if (st["Running"] === true) {
    // HEALTHCHECK 仍在 starting：主状态 running，附带 health=starting
    return withOptionalMeta(
      { status: "running" },
      { health, detail: statusText },
    );
  }

  if (
    st["Running"] === false ||
    typeof st["Status"] === "string" ||
    st["Pid"] === 0
  ) {
    if (statusLower === "dead") {
      return withOptionalMeta(
        { status: "stopped" },
        { detail: statusText ?? "已死亡" },
      );
    }
    return withOptionalMeta(
      { status: "stopped" },
      { health, detail: statusText },
    );
  }

  if (statusText) {
    return mapStatusString(statusText);
  }
  return { status: "unavailable", reason: "无法判定容器状态" };
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readNestedNumber(
  root: Record<string, unknown>,
  path: readonly string[],
): number | null {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return asFiniteNumber(cursor);
}

function resolveOnlineCpus(root: Record<string, unknown>): number {
  const onlineCpusRaw =
    readNestedNumber(root, ["cpu_stats", "online_cpus"]) ??
    (() => {
      const perCpu = (root["cpu_stats"] as Record<string, unknown> | undefined)?.[
        "cpu_usage"
      ] as Record<string, unknown> | undefined;
      const arr = perCpu?.["percpu_usage"];
      return Array.isArray(arr) && arr.length > 0 ? arr.length : 1;
    })();
  return typeof onlineCpusRaw === "number" && onlineCpusRaw > 0
    ? onlineCpusRaw
    : 1;
}

/**
 * 从 stats JSON 提取当前 CPU 计数（one-shot 与 stream=0 共用）。
 * one-shot 时 precpu 常为空，需与进程内上一拍做差分。
 */
export function extractCpuCounterSample(
  payload: unknown,
  atMs: number = Date.now(),
): DockerCpuCounterSample | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const totalUsage = readNestedNumber(root, [
    "cpu_stats",
    "cpu_usage",
    "total_usage",
  ]);
  const systemUsage = readNestedNumber(root, ["cpu_stats", "system_cpu_usage"]);
  if (totalUsage === null || systemUsage === null) {
    return null;
  }
  return {
    totalUsage,
    systemUsage,
    onlineCpus: resolveOnlineCpus(root),
    atMs,
  };
}

/**
 * 用两拍 CPU 计数计算占用率（与 docker CLI 一致）。
 * 若 prev 缺失/过期/回绕，返回 undefined（不伪造 0，避免冷启动误导）。
 */
export function cpuPercentFromSamples(
  prev: DockerCpuCounterSample | null | undefined,
  current: DockerCpuCounterSample,
  maxAgeMs: number = DOCKER_CPU_SAMPLE_MAX_AGE_MS,
): number | undefined {
  if (prev === undefined || prev === null) {
    return undefined;
  }
  if (current.atMs - prev.atMs > maxAgeMs || current.atMs < prev.atMs) {
    return undefined;
  }
  const cpuDelta = current.totalUsage - prev.totalUsage;
  const systemDelta = current.systemUsage - prev.systemUsage;
  if (systemDelta <= 0 || cpuDelta < 0) {
    return undefined;
  }
  const onlineCpus =
    current.onlineCpus > 0 ? current.onlineCpus : prev.onlineCpus || 1;
  return clampPercent((cpuDelta / systemDelta) * onlineCpus * 100);
}

export type MapStatsToResourcesOptions = {
  /**
   * 上一拍 CPU 计数。one-shot 时 precpu 常空，用此计算 cpu%。
   * 缺省时回退 payload.precpu_stats（stream=0 双采样）。
   */
  previousCpu?: DockerCpuCounterSample | null;
  /** 写入 current 采样的时间戳；默认 Date.now() */
  nowMs?: number;
  /** previousCpu 最大有效年龄 */
  maxCpuSampleAgeMs?: number;
};

export type MapStatsToResourcesResult = {
  resources: DockerResourceStats;
  /** 本拍 CPU 计数，供下次差分；无法解析时为 null */
  cpuSample: DockerCpuCounterSample | null;
};

/**
 * 将 Docker stats 响应映射为资源占用。
 * 优先 one-shot + 进程内上一拍；无上一拍时尝试 precpu_stats（兼容 stream=0）。
 * 内存：usage - cache（优先 inactive_file）/ limit，即时可用。
 */
export function mapStatsToResources(
  payload: unknown,
  options: MapStatsToResourcesOptions = {},
): DockerResourceStats {
  return mapStatsToResourcesDetailed(payload, options).resources;
}

/** 同 mapStatsToResources，额外返回本拍 CPU 计数供缓存 */
export function mapStatsToResourcesDetailed(
  payload: unknown,
  options: MapStatsToResourcesOptions = {},
): MapStatsToResourcesResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { resources: {}, cpuSample: null };
  }
  const root = payload as Record<string, unknown>;
  const out: DockerResourceStats = {};
  const nowMs = options.nowMs ?? Date.now();
  const maxAge = options.maxCpuSampleAgeMs ?? DOCKER_CPU_SAMPLE_MAX_AGE_MS;
  const cpuSample = extractCpuCounterSample(payload, nowMs);

  // 1) 进程内上一拍差分（one-shot 主路径）
  let cpuPercent =
    cpuSample !== null
      ? cpuPercentFromSamples(options.previousCpu, cpuSample, maxAge)
      : undefined;

  // 2) 回退 payload.precpu_stats（stream=0 双采样仍可用）
  // one-shot 时 precpu 常全 0：有键但 system=0，不得当有效上一拍，
  // 否则会把「自启动累计」当成「采样区间」算出虚高 CPU%，并跳过 seed 第二拍。
  if (cpuPercent === undefined) {
    const curTotal = readNestedNumber(root, [
      "cpu_stats",
      "cpu_usage",
      "total_usage",
    ]);
    const curSystem = readNestedNumber(root, ["cpu_stats", "system_cpu_usage"]);
    const preTotal = readNestedNumber(root, [
      "precpu_stats",
      "cpu_usage",
      "total_usage",
    ]);
    const preSystem = readNestedNumber(root, [
      "precpu_stats",
      "system_cpu_usage",
    ]);
    if (
      curTotal !== null &&
      curSystem !== null &&
      preTotal !== null &&
      preSystem !== null &&
      preSystem > 0
    ) {
      const cpuDelta = curTotal - preTotal;
      const systemDelta = curSystem - preSystem;
      const onlineCpus = resolveOnlineCpus(root);
      if (systemDelta > 0 && cpuDelta >= 0) {
        cpuPercent = clampPercent((cpuDelta / systemDelta) * onlineCpus * 100);
      }
    }
  }

  if (cpuPercent !== undefined) {
    out.cpuPercent = cpuPercent;
  }

  const usage = readNestedNumber(root, ["memory_stats", "usage"]);
  const limit = readNestedNumber(root, ["memory_stats", "limit"]);
  if (usage !== null && usage >= 0) {
    out.memoryUsageBytes = usage;
  }
  if (limit !== null && limit > 0) {
    out.memoryLimitBytes = limit;
  }

  if (usage !== null && limit !== null && limit > 0) {
    // 优先 cgroup v2 的 inactive_file；回退 total_inactive_file / cache
    const statsObj = (root["memory_stats"] as Record<string, unknown> | undefined)?.[
      "stats"
    ] as Record<string, unknown> | undefined;
    const inactiveFile =
      asFiniteNumber(statsObj?.["inactive_file"]) ??
      asFiniteNumber(statsObj?.["total_inactive_file"]) ??
      asFiniteNumber(statsObj?.["cache"]) ??
      0;
    const used = Math.max(0, usage - Math.max(0, inactiveFile));
    out.memoryPercent = clampPercent((used / limit) * 100);
    out.memoryUsageBytes = used;
  }

  return { resources: out, cpuSample };
}

/** 进程内上一拍 CPU 计数：key = endpointKey\0container */
const previousCpuSamples = new Map<string, DockerCpuCounterSample>();

export function dockerEndpointCacheKey(endpoint: DockerEndpoint): string {
  if (endpoint.kind === "unix") {
    return `unix:${endpoint.socketPath}`;
  }
  const scheme = endpoint.tls === true ? "https" : "tcp";
  return `${scheme}:${endpoint.host}:${endpoint.port}`;
}

export function cpuSampleCacheKey(
  endpoint: DockerEndpoint,
  containerNameOrId: string,
): string {
  return `${dockerEndpointCacheKey(endpoint)}\0${containerNameOrId}`;
}

export function getPreviousCpuSample(
  endpoint: DockerEndpoint,
  containerNameOrId: string,
): DockerCpuCounterSample | undefined {
  return previousCpuSamples.get(cpuSampleCacheKey(endpoint, containerNameOrId));
}

export function setPreviousCpuSample(
  endpoint: DockerEndpoint,
  containerNameOrId: string,
  sample: DockerCpuCounterSample,
): void {
  previousCpuSamples.set(
    cpuSampleCacheKey(endpoint, containerNameOrId),
    sample,
  );
}

/** 测试用：清空进程内 CPU 上一拍 */
export function clearPreviousCpuSamples(): void {
  previousCpuSamples.clear();
}

export function mergeRunningWithStats(
  status: DockerStatusResponse,
  stats: DockerResourceStats,
): DockerStatusResponse {
  if (status.status !== "running") {
    return status;
  }
  const merged: DockerStatusResponse = { status: "running" };
  if (status.health !== undefined) merged.health = status.health;
  if (status.detail !== undefined) merged.detail = status.detail;
  if (stats.cpuPercent !== undefined) merged.cpuPercent = stats.cpuPercent;
  if (stats.memoryPercent !== undefined) {
    merged.memoryPercent = stats.memoryPercent;
  }
  if (stats.memoryUsageBytes !== undefined) {
    merged.memoryUsageBytes = stats.memoryUsageBytes;
  }
  if (stats.memoryLimitBytes !== undefined) {
    merged.memoryLimitBytes = stats.memoryLimitBytes;
  }
  return merged;
}

function mapStatusString(statusText: string): DockerStatusResponse {
  const raw = statusText.trim();
  const s = raw.toLowerCase();
  const detail = truncateDetail(raw);

  if (s === "running" || s.startsWith("up ")) {
    // 列表 Status 常见 "Up 2 hours (healthy)"
    let health: DockerHealth | undefined;
    if (s.includes("(healthy)")) health = "healthy";
    else if (s.includes("(unhealthy)")) health = "unhealthy";
    else if (s.includes("(health: starting)") || s.includes("(starting)")) {
      health = "starting";
    }
    return withOptionalMeta({ status: "running" }, { health, detail });
  }
  if (s === "restarting" || s.startsWith("restarting")) {
    return withOptionalMeta({ status: "restarting" }, { detail });
  }
  if (s === "paused" || (s.startsWith("up ") && s.includes("(paused)"))) {
    return withOptionalMeta({ status: "paused" }, { detail });
  }
  if (s.startsWith("paused")) {
    return withOptionalMeta({ status: "paused" }, { detail });
  }
  if (s === "created" || s === "removing" || s.startsWith("created")) {
    return withOptionalMeta({ status: "starting" }, { detail });
  }
  if (
    s === "exited" ||
    s.startsWith("exited") ||
    s === "dead" ||
    s === "stopped" ||
    s.startsWith("dead")
  ) {
    return withOptionalMeta({ status: "stopped" }, { detail });
  }
  return { status: "unavailable", reason: "无法判定容器状态" };
}

function mapListState(raw: unknown): DockerContainerSummary["state"] {
  if (typeof raw !== "string") return "other";
  const s = raw.trim().toLowerCase();
  if (s === "running") return "running";
  if (s === "restarting") return "restarting";
  if (s === "paused") return "paused";
  if (s === "created" || s === "removing") return "starting";
  if (
    s === "exited" ||
    s === "dead" ||
    s === "stopped"
  ) {
    return "stopped";
  }
  return "other";
}

function mapListHealth(statusText: unknown): DockerHealth | undefined {
  if (typeof statusText !== "string") return undefined;
  const s = statusText.toLowerCase();
  if (s.includes("(healthy)")) return "healthy";
  if (s.includes("(unhealthy)")) return "unhealthy";
  if (s.includes("(health: starting)") || s.includes("(starting)")) {
    return "starting";
  }
  return undefined;
}

function pickContainerName(names: unknown, id: unknown): string | null {
  if (Array.isArray(names)) {
    for (const n of names) {
      if (typeof n !== "string") continue;
      const trimmed = n.trim().replace(/^\/+/, "");
      if (trimmed.length > 0) return trimmed;
    }
  }
  if (typeof id === "string") {
    const short = id.trim().slice(0, 12);
    return short.length > 0 ? short : null;
  }
  return null;
}

function mapPorts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ports: string[] = [];
  for (const p of raw) {
    if (p === null || typeof p !== "object" || Array.isArray(p)) continue;
    const row = p as Record<string, unknown>;
    const privatePort = row["PrivatePort"];
    const publicPort = row["PublicPort"];
    const type = typeof row["Type"] === "string" ? row["Type"] : "tcp";
    if (typeof privatePort !== "number") continue;
    if (typeof publicPort === "number") {
      ports.push(`${publicPort}:${privatePort}/${type}`);
    } else {
      ports.push(`${privatePort}/${type}`);
    }
    if (ports.length >= 8) break;
  }
  return ports.length > 0 ? ports : undefined;
}

/** 将 Docker /containers/json 条目映射为安全摘要；丢弃 Env/Labels/Mounts 等 */
export function mapListItemToSummary(
  raw: unknown,
): DockerContainerSummary | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const name = pickContainerName(row["Names"], row["Id"]);
  if (name === null) return null;

  const summary: DockerContainerSummary = {
    name,
    state: mapListState(row["State"]),
  };

  if (typeof row["Image"] === "string" && row["Image"].trim()) {
    summary.image = row["Image"].trim();
  }
  if (typeof row["Status"] === "string" && row["Status"].trim()) {
    const text = row["Status"].trim();
    summary.statusText = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const health = mapListHealth(text);
    if (health !== undefined) summary.health = health;
  }
  const ports = mapPorts(row["Ports"]);
  if (ports !== undefined) summary.ports = ports;

  return summary;
}

export function mapListPayloadToSummaries(
  payload: unknown,
): DockerContainerSummary[] {
  if (!Array.isArray(payload)) return [];
  const out: DockerContainerSummary[] = [];
  const seen = new Set<string>();
  for (const item of payload) {
    const summary = mapListItemToSummary(item);
    if (summary === null) continue;
    if (seen.has(summary.name)) continue;
    seen.add(summary.name);
    out.push(summary);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return out;
}

/** 按端点复用 keep-alive，避免每次 inspect/stats 都新建 socket */
const dockerUnixAgents = new Map<string, http.Agent>();
const dockerTcpAgents = new Map<string, http.Agent>();
const dockerTlsAgents = new Map<string, https.Agent>();

function agentForEndpoint(endpoint: DockerEndpoint): http.Agent | https.Agent {
  if (endpoint.kind === "unix") {
    let agent = dockerUnixAgents.get(endpoint.socketPath);
    if (agent === undefined) {
      agent = new http.Agent({ keepAlive: true, maxSockets: 24 });
      dockerUnixAgents.set(endpoint.socketPath, agent);
    }
    return agent;
  }
  if (endpoint.tls === true) {
    const key = `${endpoint.host}:${endpoint.port}`;
    let agent = dockerTlsAgents.get(key);
    if (agent === undefined) {
      // 局域网 Docker TLS 常见自签证书，跳过校验（信任模型 A）
      agent = new https.Agent({
        keepAlive: true,
        maxSockets: 24,
        rejectUnauthorized: false,
      });
      dockerTlsAgents.set(key, agent);
    }
    return agent;
  }
  const key = `${endpoint.host}:${endpoint.port}`;
  let agent = dockerTcpAgents.get(key);
  if (agent === undefined) {
    agent = new http.Agent({ keepAlive: true, maxSockets: 24 });
    dockerTcpAgents.set(key, agent);
  }
  return agent;
}

export function createDockerTransport(
  endpoint: DockerEndpoint,
  timeoutMs: number = DOCKER_TIMEOUT_MS,
): DockerTransport {
  const agent = agentForEndpoint(endpoint);
  return {
    async request(req: DockerClientRequest): Promise<DockerClientResponse> {
      assertReadonlyDockerRequest(req);
      return await new Promise<DockerClientResponse>((resolve, reject) => {
        const headers = {
          host: "localhost",
          accept: "application/json",
        };

        let settled = false;
        const settleError = (err: DockerClientError) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        const settleOk = (value: DockerClientResponse) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        const onResponse = (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          });
          res.on("end", () => {
            settleOk({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", () => {
            settleError(
              new DockerClientError("读取 Docker 响应失败", "unreachable"),
            );
          });
        };

        let request: http.ClientRequest;

        if (endpoint.kind === "unix") {
          request = http.request(
            {
              socketPath: endpoint.socketPath,
              path: req.path,
              method: req.method,
              headers,
              timeout: timeoutMs,
              agent: agent as http.Agent,
            },
            onResponse,
          );
        } else if (endpoint.tls === true) {
          request = https.request(
            {
              host: endpoint.host,
              port: endpoint.port,
              path: req.path,
              method: req.method,
              headers,
              timeout: timeoutMs,
              agent: agent as https.Agent,
              rejectUnauthorized: false,
            },
            onResponse,
          );
        } else {
          request = http.request(
            {
              host: endpoint.host,
              port: endpoint.port,
              path: req.path,
              method: req.method,
              headers,
              timeout: timeoutMs,
              agent: agent as http.Agent,
            },
            onResponse,
          );
        }

        request.setTimeout(timeoutMs, () => {
          request.destroy();
          settleError(new DockerClientError("查询 Docker 超时", "timeout"));
        });

        request.on("error", (err: NodeJS.ErrnoException) => {
          const code = err.code ?? "";
          if (code === "ENOENT") {
            settleError(
              new DockerClientError("Docker 端点不可达", "unreachable"),
            );
            return;
          }
          if (code === "ECONNREFUSED" || code === "EHOSTUNREACH") {
            settleError(
              new DockerClientError("Docker 端点不可达", "unreachable"),
            );
            return;
          }
          if (code === "ETIMEDOUT") {
            settleError(new DockerClientError("查询 Docker 超时", "timeout"));
            return;
          }
          settleError(
            new DockerClientError("Docker 端点不可达", "unreachable"),
          );
        });

        request.end();
      });
    },
  };
}

export function createDockerClient(
  endpoint: DockerEndpoint,
  options: {
    timeoutMs?: number;
    transport?: DockerTransport;
    /**
     * 为 false 时 running 容器只 inspect、不拉 stats（首屏状态徽章用）。
     * 默认 true，保持单容器 API 与旧批量行为。
     */
    includeStats?: boolean;
  } = {},
): DockerClient {
  const timeoutMs = options.timeoutMs ?? DOCKER_TIMEOUT_MS;
  const includeStats = options.includeStats !== false;
  const transport =
    options.transport ?? createDockerTransport(endpoint, timeoutMs);

  // one-shot stats 即时返回；超时与 inspect 同级即可
  const statsTransport =
    options.transport ??
    createDockerTransport(
      endpoint,
      Math.max(timeoutMs, DOCKER_STATS_TIMEOUT_MS),
    );

  async function requestStatsPayload(
    containerNameOrId: string,
  ): Promise<unknown | null> {
    const path = buildStatsPath(containerNameOrId);
    let response: DockerClientResponse;
    try {
      response = await statsTransport.request({ method: "GET", path });
    } catch {
      return null;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return null;
    }
  }

  async function fetchStats(
    containerNameOrId: string,
  ): Promise<DockerResourceStats> {
    const previousCpu = getPreviousCpuSample(endpoint, containerNameOrId);
    const firstPayload = await requestStatsPayload(containerNameOrId);
    if (firstPayload === null) {
      return {};
    }

    const first = mapStatsToResourcesDetailed(firstPayload, {
      ...(previousCpu !== undefined ? { previousCpu } : {}),
    });
    if (first.cpuSample !== null) {
      setPreviousCpuSample(endpoint, containerNameOrId, first.cpuSample);
    }

    // 已有 cpu%，或解析不到计数 → 直接返回（内存与 CPU 同包）
    if (
      first.resources.cpuPercent !== undefined ||
      first.cpuSample === null
    ) {
      return first.resources;
    }

    // 有计数但算不出 %（冷启动 / 上一拍失效）：短间隔补第二拍，
    // 保证本响应尽量同时带上 CPU 与内存，避免前端先内存后 CPU。
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DOCKER_CPU_SEED_GAP_MS);
    });

    const secondPayload = await requestStatsPayload(containerNameOrId);
    if (secondPayload === null) {
      return first.resources;
    }

    const second = mapStatsToResourcesDetailed(secondPayload, {
      previousCpu: first.cpuSample,
    });
    if (second.cpuSample !== null) {
      setPreviousCpuSample(endpoint, containerNameOrId, second.cpuSample);
    }
    return {
      ...first.resources,
      ...second.resources,
    };
  }

  return {
    async inspectContainer(
      containerNameOrId: string,
    ): Promise<DockerStatusResponse> {
      const path = buildInspectPath(containerNameOrId);
      let response: DockerClientResponse;
      try {
        response = await transport.request({ method: "GET", path });
      } catch (err) {
        if (err instanceof DockerClientError) {
          if (err.kind === "timeout") {
            return { status: "unavailable", reason: "查询 Docker 超时" };
          }
          return {
            status: "unavailable",
            reason: err.localMessage || "Docker 端点不可达",
          };
        }
        return { status: "unavailable", reason: "Docker 端点不可达" };
      }

      if (response.statusCode === 404) {
        return { status: "unavailable", reason: "容器不存在" };
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { status: "unavailable", reason: "Docker 接口返回错误" };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body) as unknown;
      } catch {
        return { status: "unavailable", reason: "Docker 返回了无效 JSON" };
      }

      let status: DockerStatusResponse;
      try {
        status = mapInspectToStatus(payload);
      } catch {
        return { status: "unavailable", reason: "Docker 返回了异常结构" };
      }

      if (status.status === "running" && includeStats) {
        const stats = await fetchStats(containerNameOrId);
        return mergeRunningWithStats(status, stats);
      }
      return status;
    },

    async containerStats(
      containerNameOrId: string,
    ): Promise<DockerResourceStats> {
      return fetchStats(containerNameOrId);
    },

    async listContainers(): Promise<DockerContainerSummary[]> {
      let response: DockerClientResponse;
      try {
        response = await transport.request({
          method: "GET",
          path: LIST_CONTAINERS_PATH_ALL,
        });
      } catch (err) {
        if (err instanceof DockerClientError) {
          throw err;
        }
        throw new DockerClientError("Docker 端点不可达", "unreachable");
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new DockerClientError("Docker 接口返回错误", "other");
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body) as unknown;
      } catch {
        throw new DockerClientError("Docker 返回了无效 JSON", "invalid");
      }

      return mapListPayloadToSummaries(payload);
    },
  };
}
