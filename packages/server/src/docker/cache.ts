import type { DockerStatusResponse } from "@homepage/domain";

/** 单容器状态短 TTL 缓存（进程内）。不是配置真相，仅摊薄 Docker 查询成本。 */
export const DOCKER_STATUS_CACHE_TTL_MS = 8_000;

/** lite=仅状态；full=含 stats。分桶避免轻量结果污染指标。 */
export type DockerCacheBucket = "lite" | "full";

type CacheEntry = {
  expiresAt: number;
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
): DockerStatusCache {
  const map = new Map<string, CacheEntry>();

  return {
    get(server, container, bucket: DockerCacheBucket = "full") {
      const key = cacheKey(server, container, bucket);
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(server, container, value, bucket: DockerCacheBucket = "full") {
      map.set(cacheKey(server, container, bucket), {
        expiresAt: now() + ttlMs,
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
