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

export async function queryDockerStatus(
  endpoint: DockerEndpoint,
  container: string,
  options: QueryDockerStatusOptions = {},
): Promise<DockerStatusResponse> {
  const client =
    options.createClient?.(endpoint) ??
    createDockerClient(endpoint, {
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.transport !== undefined
        ? { transport: options.transport }
        : {}),
    });

  const status = await client.inspectContainer(container);
  return DockerStatusResponseSchema.parse(status);
}

export async function queryDockerContainers(
  endpoint: DockerEndpoint,
  options: QueryDockerStatusOptions = {},
): Promise<DockerContainerSummary[]> {
  const client =
    options.createClient?.(endpoint) ??
    createDockerClient(endpoint, {
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.transport !== undefined
        ? { transport: options.transport }
        : {}),
    });

  try {
    return await client.listContainers();
  } catch (err) {
    if (err instanceof DockerClientError) {
      throw err;
    }
    throw new DockerClientError("Docker 端点不可达", "unreachable");
  }
}
