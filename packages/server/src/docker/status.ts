/** server/container 后严格匹配当次 AllowList - 未登记 → 拒绝且 Docker 调用次数为 0 - running / stopped / unavailable 映射 */
import type { AllowList, DockerEndpoint } from "@homepage/config";
import { dockerContainerKey } from "@homepage/config";
import {
  DockerStatusResponseSchema,
  type DockerContainerSummary,
  type DockerStatusResponse,
} from "@homepage/domain";

import {
  createDockerClient,
  DockerClientError,
  mergeRunningWithStats,
  type DockerClient,
  type DockerTransport,
} from "./client.js";

export type DockerAuthzResult =
  | {
      ok: true;
      server: string;
      container: string;
      endpoint: DockerEndpoint;
    }
  | { ok: false; reason: "unregistered" };

export type DockerEndpointAuthzResult =
  | {
      ok: true;
      server: string;
      endpoint: DockerEndpoint;
    }
  | { ok: false; reason: "unregistered" };

export type QueryDockerStatusOptions = {
  timeoutMs?: number;

  createClient?: (
    endpoint: DockerEndpoint,
  ) => DockerClient;
  transport?: DockerTransport;
  /** 默认 true；false 时跳过 stats，仅返回运行态/健康 */
  includeStats?: boolean;
};

export function normalizeDockerPathParam(raw: string): string {
  return raw.trim();
}

/** 严格授权：server 必须在 dockerEndpoints，且 `${server}::${container}` 在 dockerContainers。 未命中时不得创建客户端、不得发任何 Docker 请求。 */
export function authorizeDockerLookup(
  allowList: AllowList,
  serverRaw: string,
  containerRaw: string,
): DockerAuthzResult {
  const server = normalizeDockerPathParam(serverRaw);
  const container = normalizeDockerPathParam(containerRaw);
  if (server.length === 0 || container.length === 0) {
    return { ok: false, reason: "unregistered" };
  }

  const endpoint = allowList.dockerEndpoints.get(server);
  if (endpoint === undefined) {
    return { ok: false, reason: "unregistered" };
  }

  const key = dockerContainerKey(server, container);
  if (!allowList.dockerContainers.has(key)) {
    return { ok: false, reason: "unregistered" };
  }

  return { ok: true, server, container, endpoint };
}

/** 列表授权：仅要求 server 已在 docker.yaml 声明；未命中 0 次 Docker I/O */
export function authorizeDockerEndpoint(
  allowList: AllowList,
  serverRaw: string,
): DockerEndpointAuthzResult {
  const server = normalizeDockerPathParam(serverRaw);
  if (server.length === 0) {
    return { ok: false, reason: "unregistered" };
  }
  const endpoint = allowList.dockerEndpoints.get(server);
  if (endpoint === undefined) {
    return { ok: false, reason: "unregistered" };
  }
  return { ok: true, server, endpoint };
}

function buildClient(
  endpoint: DockerEndpoint,
  options: QueryDockerStatusOptions,
  includeStats: boolean,
): DockerClient {
  return (
    options.createClient?.(endpoint) ??
    createDockerClient(endpoint, {
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.transport !== undefined
        ? { transport: options.transport }
        : {}),
      includeStats,
    })
  );
}

export async function queryDockerStatus(
  endpoint: DockerEndpoint,
  container: string,
  options: QueryDockerStatusOptions = {},
): Promise<DockerStatusResponse> {
  const includeStats = options.includeStats !== false;
  const client = buildClient(endpoint, options, includeStats);
  const status = await client.inspectContainer(container);
  return DockerStatusResponseSchema.parse(status);
}

/**
 * 在已知 running 状态上只拉 stats 并合并。
 * full 路径复用 lite 缓存时使用，避免重复 inspect。
 */
export async function queryDockerStatsOnto(
  endpoint: DockerEndpoint,
  container: string,
  base: Extract<DockerStatusResponse, { status: "running" }>,
  options: QueryDockerStatusOptions = {},
): Promise<DockerStatusResponse> {
  const client = buildClient(endpoint, options, true);
  if (typeof client.containerStats !== "function") {
    // 测试注入的精简 client 可能无此方法，回退完整查询
    return queryDockerStatus(endpoint, container, {
      ...options,
      includeStats: true,
    });
  }
  const stats = await client.containerStats(container);
  return DockerStatusResponseSchema.parse(mergeRunningWithStats(base, stats));
}

export async function queryDockerContainers(
  endpoint: DockerEndpoint,
  options: QueryDockerStatusOptions = {},
): Promise<DockerContainerSummary[]> {
  const client = buildClient(endpoint, options, false);

  try {
    return await client.listContainers();
  } catch (err) {
    if (err instanceof DockerClientError) {
      throw err;
    }
    throw new DockerClientError("Docker 端点不可达", "unreachable");
  }
}
