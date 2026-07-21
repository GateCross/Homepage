/** 适配器层可注入 HTTP 与超时封装。 错误信息一律本地中文化，不得拼接密钥、Cookie 或原始响应正文。 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

export class AdapterLocalError extends Error {
  readonly localMessage: string;

  constructor(localMessage: string) {
    super(localMessage);
    this.name = "AdapterLocalError";
    this.localMessage = localMessage;
  }
}

let injectedFetch: FetchLike | undefined;

export function setAdapterFetch(fetchImpl: FetchLike | undefined): void {
  injectedFetch = fetchImpl;
}

export function getAdapterFetch(): FetchLike {
  if (injectedFetch !== undefined) {
    return injectedFetch;
  }
  if (typeof globalThis.fetch !== "function") {
    throw new AdapterLocalError("当前运行环境不支持网络请求");
  }
  return globalThis.fetch.bind(globalThis) as FetchLike;
}

export function joinBaseUrl(baseUrl: string, relativePath: string): string {
  const path = relativePath.startsWith("/")
    ? relativePath
    : `/${relativePath}`;
  try {
    const base = new URL(baseUrl);
    // 去掉末尾斜杠后拼接，避免双斜杠；保留 base 已有路径前缀
    const prefix = base.pathname.replace(/\/+$/, "");
    base.pathname = `${prefix}${path}`.replace(/\/{2,}/g, "/");
    base.search = "";
    base.hash = "";
    return base.toString();
  } catch {
    throw new AdapterLocalError("服务组件目标地址无效");
  }
}

export type AdapterRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;

  timeoutMs?: number;
  fetchImpl?: FetchLike;

  timeoutMessage?: string;

  networkMessage?: string;
};

/** 带超时的 fetch；将 AbortError / 网络错误映射为 AdapterLocalError。 不把 URL、请求头或响应正文写入错误消息。 */
export async function adapterFetch(
  url: string,
  options: AdapterRequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? getAdapterFetch();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const timeoutMessage = options.timeoutMessage ?? "请求外部服务超时";
  const networkMessage = options.networkMessage ?? "无法连接外部服务";

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      signal: controller.signal,
      redirect: "follow",
    };
    if (options.headers !== undefined) {
      init.headers = options.headers;
    }
    if (options.body !== undefined) {
      init.body = options.body;
    }
    return await fetchImpl(url, init);
  } catch (err) {
    if (err instanceof AdapterLocalError) {
      throw err;
    }
    const name =
      err !== null &&
      err !== undefined &&
      typeof err === "object" &&
      "name" in err
        ? String((err as { name: unknown }).name)
        : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new AdapterLocalError(timeoutMessage);
    }
    throw new AdapterLocalError(networkMessage);
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonBody(
  response: Response,
  invalidMessage = "外部服务返回了无效的 JSON",
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new AdapterLocalError("读取外部服务响应失败");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdapterLocalError(invalidMessage);
  }
}

export function getSetCookieLines(response: Response): string[] {
  const headers = response.headers;
  const maybe = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof maybe.getSetCookie === "function") {
    try {
      const lines = maybe.getSetCookie();
      if (Array.isArray(lines) && lines.length > 0) {
        return lines;
      }
    } catch {
      // 回退到 get
    }
  }
  const single = headers.get("set-cookie");
  if (single === null || single.length === 0) {
    return [];
  }
  return [single];
}

export function toLocalErrorMessage(
  err: unknown,
  fallback = "服务组件请求失败",
): string {
  if (err instanceof AdapterLocalError) {
    return err.localMessage;
  }
  return fallback;
}
