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
  queryDockerStatus,
  type QueryDockerStatusOptions,
} from "./status.js";

/** 单次批量查询内对 Docker Engine 的最大并行 inspect+stats 数 */
export const DOCKER_BATCH_CONCURRENCY = 6;

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

/**
 * 查询 AllowList 内全部已登记容器状态。
 * - 短 TTL 缓存命中则不打 Docker（按 includeStats 分桶）
 * - 未命中按 concurrency 并行 queryDockerStatus
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

  const results = await mapPool(targets, concurrency, async (target) => {
    if (!bypass) {
      const cached = cache.get(target.server, target.container, cacheBucket);
      if (cached !== undefined) {
        const item: DockerBatchItem = {
          server: target.server,
          container: target.container,
          result: cached,
        };
        return item;
      }
    }

    let result: DockerStatusResponse;
    try {
      result = await queryDockerStatus(
        target.endpoint,
        target.container,
        queryOptions,
      );
    } catch {
      result = { status: "unavailable", reason: "Docker 查询失败" };
    }

    if (!bypass) {
      cache.set(target.server, target.container, result, cacheBucket);
      // full 结果可兼作 lite 命中（状态字段已完整）
      if (includeStats) {
        cache.set(target.server, target.container, result, "lite");
      }
    }

    return {
      server: target.server,
      container: target.container,
      result,
    } satisfies DockerBatchItem;
  });

  return { ok: true, results };
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
    const cached = cache.get(server, container, cacheBucket);
    if (cached !== undefined) return cached;
  }

  const queryOptions: QueryDockerStatusOptions = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.createClient !== undefined
      ? { createClient: options.createClient }
      : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    includeStats,
  };

  const result = await queryDockerStatus(endpoint, container, queryOptions);
  if (!bypass) {
    cache.set(server, container, result, cacheBucket);
    if (includeStats) {
      cache.set(server, container, result, "lite");
    }
  }
  return result;
}
