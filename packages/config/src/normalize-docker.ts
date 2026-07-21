import type { AllowList, DockerEndpoint } from "./allowlist.js";

export function dockerContainerKey(server: string, container: string): string {
  return `${server}::${container}`;
}

export function parseDockerEndpointUrl(raw: unknown): DockerEndpoint | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const lower = trimmed.toLowerCase();

  // unix:///absolute/path — 方案后须为绝对路径
  if (lower.startsWith("unix://")) {
    const socketPath = trimmed.slice("unix://".length);
    if (!isValidUnixSocketPath(socketPath)) {
      return null;
    }
    return { kind: "unix", socketPath };
  }

  // tcp://host:port（host 不含斜杠与空白；port 为 1–65535）
  if (lower.startsWith("tcp://")) {
    return parseTcpEndpoint(trimmed.slice("tcp://".length));
  }

  return null;
}

function isValidUnixSocketPath(socketPath: string): boolean {
  if (socketPath.length === 0) {
    return false;
  }
  if (!socketPath.startsWith("/")) {
    return false;
  }
  // 至少一个路径段字符（不仅是 "/"）
  if (socketPath === "/") {
    return false;
  }
  if (socketPath.includes("\0")) {
    return false;
  }
  return true;
}

function parseTcpEndpoint(authority: string): DockerEndpoint | null {
  const trimmed = authority.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let host: string;
  let portText: string;

  if (trimmed.startsWith("[")) {
    // IPv6：[::1]:2375
    const close = trimmed.indexOf("]");
    if (close <= 1) {
      return null;
    }
    host = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    if (!rest.startsWith(":")) {
      return null;
    }
    portText = rest.slice(1);
  } else {
    const colon = trimmed.lastIndexOf(":");
    if (colon <= 0 || colon === trimmed.length - 1) {
      return null;
    }
    host = trimmed.slice(0, colon);
    portText = trimmed.slice(colon + 1);
    // 禁止在 host 中夹带路径或空白
    if (host.includes("/") || /\s/.test(host)) {
      return null;
    }
  }

  if (host.length === 0 || /\s/.test(host) || host.includes("/")) {
    return null;
  }

  if (!/^\d+$/.test(portText)) {
    return null;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { kind: "tcp", host, port };
}

export function normalizeDockerEndpointName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function registerDockerEndpoints(
  raw: unknown,
  allowList: AllowList,
): void {
  if (raw === null || raw === undefined) {
    return;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = normalizeDockerEndpointName(key);
    if (name === null) {
      continue;
    }
    const endpoint = parseDockerEndpointUrl(value);
    if (endpoint === null) {
      continue;
    }
    allowList.dockerEndpoints.set(name, endpoint);
  }
}

export function tryRegisterServiceDocker(
  source: Record<string, unknown>,
  allowList: AllowList | undefined,
): { server: string; container: string } | undefined {
  if (allowList === undefined) {
    return undefined;
  }

  const server = normalizeDockerEndpointName(source["server"]);
  const container = normalizeDockerEndpointName(source["container"]);
  if (server === null || container === null) {
    return undefined;
  }

  // 仅当 server 对应 docker.yaml 中已声明且解析成功的端点
  if (!allowList.dockerEndpoints.has(server)) {
    return undefined;
  }

  allowList.dockerContainers.add(dockerContainerKey(server, container));
  return { server, container };
}
