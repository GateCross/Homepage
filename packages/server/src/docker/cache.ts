import type { DockerStatusResponse } from "@homepage/domain";

/** 单容器状态短 TTL 缓存（进程内）。不是配置真相，仅摊薄 Docker stats 成本。 */
export const DOCKER_STATUS_CACHE_TTL_MS = 8_000;

type CacheEntry = {
  expiresAt: number;
  value: DockerStatusResponse;
};

function cacheKey(server: string, container: string): string {
  return `${server}\0${container}`;
}

export type DockerStatusCache = {
  get: (server: string, container: string) => DockerStatusResponse | undefined;
  set: (
    server: string,
    container: string,
    value: DockerStatusResponse,
  ) => void;
  clear: () => void;
};

export function createDockerStatusCache(
  ttlMs: number = DOCKER_STATUS_CACHE_TTL_MS,
  now: () => number = () => Date.now(),
): DockerStatusCache {
  const map = new Map<string, CacheEntry>();

  return {
    get(server, container) {
      const key = cacheKey(server, container);
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(server, container, value) {
      map.set(cacheKey(server, container), {
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
