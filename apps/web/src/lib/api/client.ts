import {
  ApiRoutes,
  parseApiSuccess,
  parseErrorEnvelope,
  type ApiSuccessRoute,
  type ApiSuccessSchemas,
  type AssetUploadSuccessResponse,
  type ConfigSuccessResponse,
  type ConfigWriteSuccessResponse,
  type DockerBatchSuccessResponse,
  type DockerContainersSuccessResponse,
  type DockerSuccessResponse,
  type EditableConfig,
  type EditableConfigWrite,
  type HttpProbeResponse,
  type IconImportSuccessResponse,
  type IconResolveSuccessResponse,
  type InfoSuccessResponse,
  type ServiceWidgetResult,
  type VersionSuccessResponse,
} from "@homepage/domain";

import {
  API_CLIENT_MESSAGES,
  ApiClientError,
} from "./errors";

const DEFAULT_TIMEOUT_MS = 30_000;

export type ApiRequestOptions = {

  baseUrl?: string;

  fetch?: typeof fetch;

  signal?: AbortSignal;
  /** 额外请求头（不得用于携带密钥） */
  headers?: HeadersInit;

  /** 超时毫秒；默认 30000 */
  timeoutMs?: number;
};

function resolveFetch(options?: ApiRequestOptions): typeof fetch {
  const impl = options?.fetch ?? globalThis.fetch;
  if (typeof impl !== "function") {
    throw new ApiClientError(API_CLIENT_MESSAGES.network, {
      kind: "network",
      cause: new Error("当前环境不支持 fetch"),
    });
  }
  return impl.bind(globalThis);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl.trim() === "") {
    return "";
  }
  return baseUrl.replace(/\/+$/, "");
}

function buildUrl(path: string, baseUrl?: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
}

async function readJsonBody(
  response: Response,
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    if (isAbortError(cause)) {
      throw cause;
    }
    throw new ApiClientError(API_CLIENT_MESSAGES.nonJson, {
      kind: "non_json",
      status: response.status,
      cause,
    });
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ApiClientError(API_CLIENT_MESSAGES.emptyBody, {
      kind: "non_json",
      status: response.status,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  const looksLikeJson =
    contentType.includes("application/json") ||
    contentType.includes("+json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");

  if (!looksLikeJson) {
    throw new ApiClientError(API_CLIENT_MESSAGES.nonJson, {
      kind: "non_json",
      status: response.status,
    });
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (cause) {
    throw new ApiClientError(API_CLIENT_MESSAGES.nonJson, {
      kind: "non_json",
      status: response.status,
      cause,
    });
  }
}

function throwFromErrorBody(body: unknown, status: number): never {
  const envelope = parseErrorEnvelope(body);
  if (envelope !== null) {
    throw new ApiClientError(envelope.error.message, {
      kind: "http_error",
      status,
      publicError: envelope.error,
    });
  }
  throw new ApiClientError(API_CLIENT_MESSAGES.httpFallback, {
    kind: "http_error",
    status,
  });
}

type RequestSuccessOptions = ApiRequestOptions & {
  method?: "GET" | "POST" | "PUT";
  body?: BodyInit;
  timeoutMessage?: string;
  timeoutMs?: number;
};

async function requestAndParseSuccess<R extends ApiSuccessRoute>(
  route: R,
  path: string,
  options: RequestSuccessOptions = {},
): Promise<(typeof ApiSuccessSchemas)[R]["_output"]> {
  const fetchImpl = resolveFetch(options);
  const { signal, cleanup } = withTimeoutSignal(
    options.signal,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetchImpl(buildUrl(path, options.baseUrl), {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body instanceof FormData
          ? {}
          : options.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        ...(options.headers ?? {}),
      },
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal,
    });
  } catch (cause) {
    cleanup();
    if (isAbortError(cause)) {
      if (options.signal?.aborted) throw cause;
      throw new ApiClientError(options.timeoutMessage ?? "请求超时，请稍后重试", {
        kind: "network",
        cause,
      });
    }
    throw new ApiClientError(API_CLIENT_MESSAGES.network, {
      kind: "network",
      cause,
    });
  }

  try {
    const body = await readJsonBody(response);
    if (!response.ok) throwFromErrorBody(body, response.status);
    try {
      return parseApiSuccess(route, body);
    } catch (cause) {
      const envelope = parseErrorEnvelope(body);
      if (envelope !== null) {
        throw new ApiClientError(envelope.error.message, {
          kind: "http_error",
          status: response.status,
          publicError: envelope.error,
        });
      }
      throw new ApiClientError(API_CLIENT_MESSAGES.invalidSuccess, {
        kind: "invalid_response",
        status: response.status,
        cause,
      });
    }
  } finally {
    cleanup();
  }
}

async function getAndParseSuccess<R extends ApiSuccessRoute>(
  route: R,
  path: string,
  options?: ApiRequestOptions,
): Promise<(typeof ApiSuccessSchemas)[R]["_output"]> {
  return requestAndParseSuccess(route, path, options);
}

function requireNonEmptyId(id: string, label: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new ApiClientError(`${label}${API_CLIENT_MESSAGES.missingId}`, {
      kind: "invalid_response",
    });
  }
  return trimmed;
}

export async function fetchConfig(
  options?: ApiRequestOptions,
): Promise<ConfigSuccessResponse> {
  return getAndParseSuccess("config", ApiRoutes.config, options);
}

export type FetchVersionOptions = ApiRequestOptions & {
  /**
   * 默认 true。false 时请求 `?check=0`，仅取本地版本（可秒回），不触发出网更新检查。
   */
  checkRemote?: boolean;
};

export async function fetchVersion(
  options?: FetchVersionOptions,
): Promise<VersionSuccessResponse> {
  const checkRemote = options?.checkRemote !== false;
  const path = checkRemote
    ? ApiRoutes.version
    : `${ApiRoutes.version}?check=0`;
  return getAndParseSuccess("version", path, options);
}

export async function fetchProbe(
  probeId: string,
  options?: ApiRequestOptions,
): Promise<HttpProbeResponse> {
  const id = requireNonEmptyId(probeId, "探测");
  const path = `${ApiRoutes.probe}/${encodeURIComponent(id)}`;
  return getAndParseSuccess("probe", path, options);
}

export async function fetchDocker(
  server: string,
  container: string,
  options?: ApiRequestOptions,
): Promise<DockerSuccessResponse> {
  const serverId = requireNonEmptyId(server, "Docker 服务端");
  const containerId = requireNonEmptyId(container, "Docker 容器");
  const path = `${ApiRoutes.docker}/${encodeURIComponent(serverId)}/${encodeURIComponent(containerId)}`;
  return getAndParseSuccess("docker", path, options);
}

export type FetchDockerBatchOptions = ApiRequestOptions & {
  /**
   * 默认 true。false 时请求 `?stats=0`，仅返回运行态/健康（首屏徽章）。
   * true 时含 CPU/内存（指标条）。
   */
  includeStats?: boolean;
};

export async function fetchDockerBatch(
  options?: FetchDockerBatchOptions,
): Promise<DockerBatchSuccessResponse> {
  const includeStats = options?.includeStats !== false;
  const path = includeStats
    ? ApiRoutes.dockerStatus
    : `${ApiRoutes.dockerStatus}?stats=0`;
  return getAndParseSuccess("dockerBatch", path, options);
}

export async function fetchDockerContainers(
  server: string,
  options?: ApiRequestOptions,
): Promise<DockerContainersSuccessResponse> {
  const serverId = requireNonEmptyId(server, "Docker 服务端");
  const path = `${ApiRoutes.docker}/${encodeURIComponent(serverId)}/containers`;
  return getAndParseSuccess("dockerContainers", path, options);
}

export async function fetchWidget(
  widgetId: string,
  options?: ApiRequestOptions,
): Promise<ServiceWidgetResult> {
  const id = requireNonEmptyId(widgetId, "服务组件");
  return requestAndParseSuccess(
    "widgetResult",
    `${ApiRoutes.widgets}/${encodeURIComponent(id)}`,
    options,
  );
}

export async function fetchInfo(
  infoId: string,
  options?: ApiRequestOptions,
): Promise<InfoSuccessResponse> {
  const id = requireNonEmptyId(infoId, "信息组件");
  const path = `${ApiRoutes.info}/${encodeURIComponent(id)}`;
  return getAndParseSuccess("info", path, options);
}

function withTimeoutSignal(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const onOuterAbort = (): void => {
    controller.abort();
  };
  if (outer) {
    if (outer.aborted) {
      controller.abort();
    } else {
      outer.addEventListener("abort", onOuterAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      if (outer) {
        outer.removeEventListener("abort", onOuterAbort);
      }
    },
  };
}

export async function fetchEditableConfig(
  options?: ApiRequestOptions,
): Promise<EditableConfig> {
  return requestAndParseSuccess("editableConfig", ApiRoutes.configEditable, options);
}

export async function saveConfig(
  payload: EditableConfigWrite,
  options?: ApiRequestOptions,
): Promise<ConfigWriteSuccessResponse> {
  return requestAndParseSuccess("configWrite", ApiRoutes.config, {
    ...options,
    method: "PUT",
    body: JSON.stringify(payload),
    timeoutMessage: "保存超时，请稍后重试",
  });
}

const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_CLIENT_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_CLIENT_UPLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export async function uploadAsset(
  file: File,
  options?: ApiRequestOptions,
): Promise<AssetUploadSuccessResponse> {
  if (!(file instanceof File) || file.size <= 0) {
    throw new ApiClientError("请选择有效的图片文件", {
      kind: "invalid_response",
    });
  }
  if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
    throw new ApiClientError("图片不能超过 5MB", {
      kind: "invalid_response",
    });
  }
  const type = (file.type || "").toLowerCase();
  const nameExt = file.name.split(".").pop()?.toLowerCase() ?? "";
  const extOk = ["jpg", "jpeg", "png", "webp", "gif", "svg", "ico"].includes(
    nameExt,
  );
  if (type.length > 0 && !ALLOWED_CLIENT_UPLOAD_TYPES.has(type) && !extOk) {
    throw new ApiClientError("仅支持 jpg、png、webp、gif、svg、ico 图片", {
      kind: "invalid_response",
    });
  }

  const form = new FormData();
  form.append("file", file, file.name);
  return requestAndParseSuccess("assetUpload", ApiRoutes.assetsUpload, {
    ...options,
    method: "POST",
    body: form,
    timeoutMs: options?.timeoutMs ?? UPLOAD_TIMEOUT_MS,
    timeoutMessage: "上传超时，请稍后重试",
  });
}

const ICON_RESOLVE_TIMEOUT_MS = 60_000;

async function postJsonAndParseSuccess<R extends "iconResolve" | "iconImport">(
  route: R,
  path: string,
  payload: unknown,
  options?: ApiRequestOptions,
): Promise<(typeof ApiSuccessSchemas)[R]["_output"]> {
  return requestAndParseSuccess(route, path, {
    ...options,
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: options?.timeoutMs ?? ICON_RESOLVE_TIMEOUT_MS,
  });
}

/** Icon Resolve：从站点发现候选图标（不写 YAML / 不落盘）。 */
export async function resolveSiteIcons(
  sourceUrl: string,
  options?: ApiRequestOptions,
): Promise<IconResolveSuccessResponse> {
  const url = sourceUrl.trim();
  if (url.length === 0) {
    throw new ApiClientError("请提供有效的链接", {
      kind: "invalid_response",
    });
  }
  return postJsonAndParseSuccess(
    "iconResolve",
    ApiRoutes.iconsResolve,
    { url },
    options,
  );
}

/** Icon Import：将会话中的候选落盘为 /images/... */
export async function importSiteIcon(
  input: { sessionId: string; candidateId: string },
  options?: ApiRequestOptions,
): Promise<IconImportSuccessResponse> {
  const sessionId = input.sessionId.trim();
  const candidateId = input.candidateId.trim();
  if (!sessionId || !candidateId) {
    throw new ApiClientError("缺少会话或候选标识", {
      kind: "invalid_response",
    });
  }
  return postJsonAndParseSuccess(
    "iconImport",
    ApiRoutes.iconsImport,
    { sessionId, candidateId },
    options,
  );
}
