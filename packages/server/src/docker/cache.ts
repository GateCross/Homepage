import type { DockerStatusResponse } from "@homepage/domain";

/**
 * 新鲜窗口：命中则直接返回，不打 Docker。
 * 与前端 15s 轮询对齐，略短于轮询以免永远陈旧。
 */
export const DOCKER_STATUS_CACHE_TTL_MS = 12_000;

/**
 * 陈旧仍可服务窗口：过期后先返回旧值并后台刷新（SWR）。
 * 冷路径（无缓存）仍走实时查询。
 */
export const DOCKER_STATUS_CACHE_STALE_MS = 45_000;

/** lite=仅状态；full=含 stats。分桶避免轻量结果污染指标。 */
export type DockerCacheBucket = "lite" | "full";

export type DockerCacheHit =
  | { kind: "fresh"; value: DockerStatusResponse }
  | { kind: "stale"; value: DockerStatusResponse }
  | { kind: "miss" };

type CacheEntry = {
  /** 新鲜截止；之后仍可在 staleUntil 前作 SWR */
  freshUntil: number;
  staleUntil: number;
  value: DockerStatusResponse;
};

function cacheKey(
  server: string,
  container: string,
  bucket: DockerCacheBucket,
): string {
  return `${bucket}\0${server}\0${container}`;
}

export type DockerStatusCache = {
  get: (
    server: string,
    container: string,
    bucket?: DockerCacheBucket,
  ) => DockerStatusResponse | undefined;
  /** 区分 fresh / stale / miss，供批量 SWR */
  lookup: (
    server: string,
    container: string,
    bucket?: DockerCacheBucket,
  ) => DockerCacheHit;
  set: (
    server: string,
    container: string,
    value: DockerStatusResponse,
    bucket?: DockerCacheBucket,
  ) => void;
  clear: () => void;
};

export function createDockerStatusCache(
  ttlMs: number = DOCKER_STATUS_CACHE_TTL_MS,
  now: () => number = () => Date.now(),
  staleMs: number = DOCKER_STATUS_CACHE_STALE_MS,
): DockerStatusCache {
  const map = new Map<string, CacheEntry>();

  function lookup(
    server: string,
    container: string,
    bucket: DockerCacheBucket = "full",
  ): DockerCacheHit {
    const key = cacheKey(server, container, bucket);
    const entry = map.get(key);
    if (entry === undefined) return { kind: "miss" };
    const t = now();
    if (t < entry.freshUntil) {
      return { kind: "fresh", value: entry.value };
    }
    if (t < entry.staleUntil) {
      return { kind: "stale", value: entry.value };
    }
    map.delete(key);
    return { kind: "miss" };
  }

  return {
    get(server, container, bucket: DockerCacheBucket = "full") {
      const hit = lookup(server, container, bucket);
      // 兼容旧调用方：仅 fresh 视为命中（避免把陈旧当新鲜）
      return hit.kind === "fresh" ? hit.value : undefined;
    },
    lookup,
    set(server, container, value, bucket: DockerCacheBucket = "full") {
      const t = now();
      map.set(cacheKey(server, container, bucket), {
        freshUntil: t + ttlMs,
        staleUntil: t + Math.max(ttlMs, staleMs),
        value,
      });
    },
    clear() {
      map.clear();
    },
  };
}

/** 进程默认缓存：供路由复用。测试可注入独立实例。 */
export const defaultDockerStatusCache = createDockerStatusCache();
