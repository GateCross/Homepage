import type { AllowList, DockerEndpoint } from "@homepage/config";
import { dockerContainerKey } from "@homepage/config";
import type {
  DockerBatchItem,
  DockerBatchStatusResponse,
  DockerStatusResponse,
} from "@homepage/domain";

import type { DockerStatusCache } from "./cache.js";
import { defaultDockerStatusCache } from "./cache.js";
import {
  queryDockerStatsOnto,
  queryDockerStatus,
  type QueryDockerStatusOptions,
} from "./status.js";

/** 单次批量查询内对 Docker Engine 的最大并行数（stats 采样慢，适当提高） */
export const DOCKER_BATCH_CONCURRENCY = 12;

export type RegisteredDockerTarget = {
  server: string;
  container: string;
  endpoint: DockerEndpoint;
};

/** 从当次 AllowList 枚举全部已登记容器（server::container） */
export function listRegisteredDockerTargets(
  allowList: AllowList,
): RegisteredDockerTarget[] {
  const out: RegisteredDockerTarget[] = [];
  for (const key of allowList.dockerContainers) {
    const sep = key.indexOf("::");
    if (sep <= 0 || sep >= key.length - 2) continue;
    const server = key.slice(0, sep);
    const container = key.slice(sep + 2);
    if (server.length === 0 || container.length === 0) continue;
    const endpoint = allowList.dockerEndpoints.get(server);
    if (endpoint === undefined) continue;
    // 再校验 key 规范，防止脏数据
    if (dockerContainerKey(server, container) !== key) continue;
    out.push({ server, container, endpoint });
  }
  // 稳定顺序，便于测试与缓存命中观感
  out.sort((a, b) => {
    const s = a.server.localeCompare(b.server, "en");
    if (s !== 0) return s;
    return a.container.localeCompare(b.container, "en");
  });
  return out;
}

export type QueryDockerBatchOptions = QueryDockerStatusOptions & {
  concurrency?: number;
  cache?: DockerStatusCache;
  /** 为 true 时跳过缓存读写（一般不必） */
  bypassCache?: boolean;
  /**
   * 默认 true。false 时仅 inspect（状态徽章），不拉 stats。
   * 轻量结果与完整结果分桶缓存，避免互相污染。
   */
  includeStats?: boolean;
};

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

/** 同一 server+container+bucket 并发去重，避免 lite 预热与 full 请求重复打 Docker */
const inflight = new Map<string, Promise<unknown>>();

function inflightKey(
  server: string,
  container: string,
  bucket: "lite" | "full",
): string {
  return `${bucket}\0${server}\0${container}`;
}

async function withInflight<T>(
  server: string,
  container: string,
  bucket: "lite" | "full",
  work: () => Promise<T>,
): Promise<T> {
  const key = inflightKey(server, container, bucket);
  const existing = inflight.get(key);
  if (existing !== undefined) return existing as Promise<T>;
  const promise = work().finally(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  inflight.set(key, promise);
  return promise;
}

function isRunningStatus(
  result: DockerStatusResponse,
): result is Extract<DockerStatusResponse, { status: "running" }> {
  return result.status === "running";
}

const DOCKER_QUERY_FAIL: DockerStatusResponse = {
  status: "unavailable",
  reason: "Docker 查询失败",
};

type FullStatusQuery = {
  result: DockerStatusResponse;
  /**
   * 是否写入/续期缓存。
   * stats 失败降级为无指标 running 时为 false，避免把降级结果当成新鲜 full/lite。
   */
  persist: boolean;
};

/**
 * full 查询：优先复用 **fresh** lite 缓存，running 只补 stats；
 * stale lite 不可信（容器可能已停），回退完整 inspect+stats。
 */
async function queryFullStatus(
  target: RegisteredDockerTarget,
  cache: DockerStatusCache,
  bypass: boolean,
  queryOptions: QueryDockerStatusOptions,
): Promise<FullStatusQuery> {
  if (!bypass) {
    const liteHit = cache.lookup(target.server, target.container, "lite");
    // 仅 fresh lite 可复用；stale 必须 re-inspect，避免把已停容器当 running 补 stats
    if (liteHit.kind === "fresh") {
      const lite = liteHit.value;
      if (!isRunningStatus(lite)) {
        return { result: lite, persist: true };
      }
      return withInflight(target.server, target.container, "full", async () => {
        try {
          const result = await queryDockerStatsOnto(
            target.endpoint,
            target.container,
            lite,
            queryOptions,
          );
          return { result, persist: true };
        } catch {
          // stats 失败：保留运行态返回，但不续期 full/lite 缓存
          return { result: lite, persist: false };
        }
      });
    }
  }

  return withInflight(target.server, target.container, "full", async () => {
    try {
      const result = await queryDockerStatus(target.endpoint, target.container, {
        ...queryOptions,
        includeStats: true,
      });
      return { result, persist: true };
    } catch {
      return {
        result: DOCKER_QUERY_FAIL,
        persist: true,
      };
    }
  });
}

/** full 结果写入缓存；persist=false 时跳过，避免降级结果续期 */
function persistFullStatus(
  cache: DockerStatusCache,
  server: string,
  container: string,
  query: FullStatusQuery,
): void {
  if (!query.persist) return;
  cache.set(server, container, query.result, "full");
  cache.set(server, container, query.result, "lite");
}

/**
 * 查询 AllowList 内全部已登记容器状态。
 * - 短 TTL 缓存命中则不打 Docker（按 includeStats 分桶）
 * - stale 命中：立即返回陈旧值并后台刷新（SWR），避免 15s 轮询反复冷启动
 * - full 可复用 lite 状态，running 仅补 stats
 * - 未命中按 concurrency 并行
 * - 单容器失败映射为 unavailable，不拖垮整批
 */
export async function queryDockerBatchStatus(
  allowList: AllowList,
  options: QueryDockerBatchOptions = {},
): Promise<DockerBatchStatusResponse> {
  const targets = listRegisteredDockerTargets(allowList);
  const cache = options.cache ?? defaultDockerStatusCache;
  const concurrency = options.concurrency ?? DOCKER_BATCH_CONCURRENCY;
  const bypass = options.bypassCache === true;
  const includeStats = options.includeStats !== false;
  const cacheBucket = includeStats ? "full" : "lite";

  const queryOptions: QueryDockerStatusOptions = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.createClient !== undefined
      ? { createClient: options.createClient }
      : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    includeStats,
  };

  const backgroundRefresh: RegisteredDockerTarget[] = [];

  const results = await mapPool(targets, concurrency, async (target) => {
    if (!bypass) {
      const hit = cache.lookup(target.server, target.container, cacheBucket);
      if (hit.kind === "fresh") {
        return {
          server: target.server,
          container: target.container,
          result: hit.value,
        } satisfies DockerBatchItem;
      }
      if (hit.kind === "stale") {
        // 先回陈旧，后台刷新；同 key inflight 去重
        backgroundRefresh.push(target);
        return {
          server: target.server,
          container: target.container,
          result: hit.value,
        } satisfies DockerBatchItem;
      }
    }

    let result: DockerStatusResponse;
    if (includeStats) {
      const full = await queryFullStatus(target, cache, bypass, queryOptions);
      result = full.result;
      if (!bypass) {
        persistFullStatus(cache, target.server, target.container, full);
      }
    } else {
      result = await withInflight(
        target.server,
        target.container,
        "lite",
        async () => {
          try {
            return await queryDockerStatus(
              target.endpoint,
              target.container,
              queryOptions,
            );
          } catch {
            return DOCKER_QUERY_FAIL;
          }
        },
      );
      if (!bypass) {
        cache.set(target.server, target.container, result, "lite");
      }
    }

    return {
      server: target.server,
      container: target.container,
      result,
    } satisfies DockerBatchItem;
  });

  if (backgroundRefresh.length > 0 && !bypass) {
    void refreshTargetsInBackground(
      backgroundRefresh,
      cache,
      cacheBucket,
      includeStats,
      concurrency,
      queryOptions,
    );
  }

  return { ok: true, results };
}

async function refreshTargetsInBackground(
  targets: readonly RegisteredDockerTarget[],
  cache: DockerStatusCache,
  cacheBucket: "lite" | "full",
  includeStats: boolean,
  concurrency: number,
  queryOptions: QueryDockerStatusOptions,
): Promise<void> {
  try {
    await mapPool(targets, concurrency, async (target) => {
      // 若刷新启动时已有同桶 inflight / 又变 fresh，query 层仍会去重
      if (includeStats) {
        const full = await queryFullStatus(target, cache, false, queryOptions);
        persistFullStatus(cache, target.server, target.container, full);
        return full.result;
      }
      const result = await withInflight(
        target.server,
        target.container,
        "lite",
        async () => {
          try {
            return await queryDockerStatus(
              target.endpoint,
              target.container,
              queryOptions,
            );
          } catch {
            return DOCKER_QUERY_FAIL;
          }
        },
      );
      cache.set(target.server, target.container, result, cacheBucket);
      return result;
    });
  } catch {
    // 后台刷新失败不影响已返回的响应
  }
}

/**
 * 单容器查询：先缓存，未命中再查并写入。
 * 供旧路由 /api/docker/:server/:container 复用，与批量共享 TTL。
 */
export async function queryDockerStatusCached(
  server: string,
  container: string,
  endpoint: DockerEndpoint,
  options: QueryDockerBatchOptions = {},
): Promise<DockerStatusResponse> {
  const cache = options.cache ?? defaultDockerStatusCache;
  const bypass = options.bypassCache === true;
  const includeStats = options.includeStats !== false;
  const cacheBucket = includeStats ? "full" : "lite";
  if (!bypass) {
    const hit = cache.lookup(server, container, cacheBucket);
    if (hit.kind === "fresh") return hit.value;
    if (hit.kind === "stale") {
      // 单容器路径同样 SWR：先回陈旧，后台刷新
      void (async () => {
        try {
          const queryOptions: QueryDockerStatusOptions = {
            ...(options.timeoutMs !== undefined
              ? { timeoutMs: options.timeoutMs }
              : {}),
            ...(options.createClient !== undefined
              ? { createClient: options.createClient }
              : {}),
            ...(options.transport !== undefined
              ? { transport: options.transport }
              : {}),
            includeStats,
          };
          const target = { server, container, endpoint };
          if (includeStats) {
            const full = await queryFullStatus(
              target,
              cache,
              false,
              queryOptions,
            );
            persistFullStatus(cache, server, container, full);
          } else {
            const fresh = await withInflight(
              server,
              container,
              "lite",
              async () => {
                try {
                  return await queryDockerStatus(
                    endpoint,
                    container,
                    queryOptions,
                  );
                } catch {
                  return DOCKER_QUERY_FAIL;
                }
              },
            );
            cache.set(server, container, fresh, "lite");
          }
        } catch {
          // ignore
        }
      })();
      return hit.value;
    }
  }

  const queryOptions: QueryDockerStatusOptions = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.createClient !== undefined
      ? { createClient: options.createClient }
      : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    includeStats,
  };

  if (includeStats) {
    const full = await queryFullStatus(
      { server, container, endpoint },
      cache,
      bypass,
      queryOptions,
    );
    if (!bypass) {
      persistFullStatus(cache, server, container, full);
    }
    return full.result;
  }

  const result = await withInflight(server, container, "lite", async () => {
    try {
      return await queryDockerStatus(endpoint, container, queryOptions);
    } catch {
      return DOCKER_QUERY_FAIL;
    }
  });

  if (!bypass) {
    cache.set(server, container, result, "lite");
  }
  return result;
}
