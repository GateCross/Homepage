/** 适配器层可注入 HTTP 与超时封装。 错误信息一律本地中文化，不得拼接密钥、Cookie 或原始响应正文。 */
import * as http from "node:http";
import * as https from "node:https";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

/** 适配器 HTTPS 默认跳过证书校验（内网自签，与 Probe 对齐） */
export const DEFAULT_ADAPTER_INSECURE_TLS = true;

/**
 * 适配器响应体默认上限。
 * qBittorrent / Transmission 等会返回完整种子列表，2MB 过紧；
 * 仍保留上限以防异常大包拖垮进程。
 */
export const DEFAULT_ADAPTER_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

/** 下载客户端种子列表等大响应专用上限 */
export const ADAPTER_LARGE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

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

  /**
   * 是否跳过 TLS 证书校验。
   * 默认 true（局域网自签证书）；注入 fetchImpl 时由注入方处理。
   */
  insecureTls?: boolean;

  /** 响应体上限（字节）；默认 DEFAULT_ADAPTER_RESPONSE_MAX_BYTES */
  maxBytes?: number;
};

/** 与 fetch redirect:"follow" 对齐的最大跳转次数 */
const MAX_ADAPTER_REDIRECTS = 20;

const REDIRECT_SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

type NodeAdapterRequestOptions = {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** 单次适配器请求的总超时（含重定向链） */
  timeoutMs: number;
  /** 整条请求链的截止时间戳（Date.now() 坐标系） */
  deadlineMs: number;
  insecureTls: boolean;
  maxBytes: number;
};

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 301/302/303 按 Fetch 规范将非 GET/HEAD 改为 GET 并丢弃 body；307/308 保留方法与 body */
function redirectMethodAndBody(
  status: number,
  method: string,
  body: string | undefined,
): { method: string; body: string | undefined } {
  const upper = method.toUpperCase();
  if (status === 307 || status === 308) {
    return { method, body };
  }
  if (upper === "GET" || upper === "HEAD") {
    return { method: upper, body: undefined };
  }
  return { method: "GET", body: undefined };
}

function stripSensitiveHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REDIRECT_SENSITIVE_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function sameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.port === b.port
  );
}

function nodeAdapterRequest(
  url: string,
  options: NodeAdapterRequestOptions,
  redirectCount = 0,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const remainingMs = options.deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(
        Object.assign(new Error("请求外部服务超时"), {
          name: "TimeoutError",
          code: "ABORT_ERR",
        }),
      );
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new AdapterLocalError("服务组件目标地址无效"));
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new AdapterLocalError("服务组件仅支持 http/https 目标"));
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const reqHeaders: Record<string, string> = {
      ...(options.headers ?? {}),
    };
    if (options.body !== undefined && reqHeaders["content-length"] === undefined) {
      reqHeaders["content-length"] = String(Buffer.byteLength(options.body));
    }

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method,
        headers: reqHeaders,
        timeout: remainingMs,
        ...(isHttps ? { rejectUnauthorized: !options.insecureTls } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const locationHeader = res.headers.location;
        const location =
          typeof locationHeader === "string"
            ? locationHeader
            : Array.isArray(locationHeader)
              ? locationHeader[0]
              : undefined;

        if (
          isRedirectStatus(status) &&
          typeof location === "string" &&
          location.length > 0
        ) {
          // 丢弃重定向响应体，避免占满 maxBytes 预算
          res.resume();
          if (redirectCount >= MAX_ADAPTER_REDIRECTS) {
            reject(new AdapterLocalError("外部服务重定向次数过多"));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, parsed);
          } catch {
            reject(new AdapterLocalError("外部服务返回了无效的重定向地址"));
            return;
          }
          if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
            reject(new AdapterLocalError("服务组件仅支持 http/https 目标"));
            return;
          }
          const { method: nextMethod, body: nextBody } = redirectMethodAndBody(
            status,
            options.method,
            options.body,
          );
          let nextHeaders = options.headers;
          if (!sameOrigin(parsed, nextUrl)) {
            nextHeaders = stripSensitiveHeaders(options.headers);
          }
          // 方法变更后去掉可能过期的 Content-Length / Content-Type
          if (nextBody === undefined && nextHeaders !== undefined) {
            const cleaned: Record<string, string> = {};
            for (const [key, value] of Object.entries(nextHeaders)) {
              const lower = key.toLowerCase();
              if (lower === "content-length" || lower === "content-type") {
                continue;
              }
              cleaned[key] = value;
            }
            nextHeaders = cleaned;
          }
          void nodeAdapterRequest(
            nextUrl.toString(),
            {
              method: nextMethod,
              timeoutMs: options.timeoutMs,
              deadlineMs: options.deadlineMs,
              insecureTls: options.insecureTls,
              maxBytes: options.maxBytes,
              ...(nextHeaders !== undefined ? { headers: nextHeaders } : {}),
              ...(nextBody !== undefined ? { body: nextBody } : {}),
            },
            redirectCount + 1,
          ).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let exceeded = false;
        res.on("data", (chunk: Buffer | string) => {
          if (exceeded) {
            return;
          }
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          total += buf.byteLength;
          if (total > options.maxBytes) {
            exceeded = true;
            res.destroy();
            req.destroy();
            reject(new AdapterLocalError("外部服务响应体积超过限制"));
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (exceeded) {
            return;
          }
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const item of value) {
                headers.append(key, item);
              }
            } else {
              headers.set(key, value);
            }
          }
          // Undici Response 仅接受 200–599；异常空状态码回退为 502
          const safeStatus =
            Number.isInteger(status) && status >= 200 && status <= 599
              ? status
              : 502;
          resolve(
            new Response(body, {
              status: safeStatus,
              statusText: res.statusMessage ?? "",
              headers,
            }),
          );
        });
        res.on("error", (err) => {
          if (exceeded) {
            return;
          }
          reject(err);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(
        Object.assign(new Error("请求外部服务超时"), {
          name: "TimeoutError",
          code: "ABORT_ERR",
        }),
      );
    });
    req.on("error", (err) => {
      reject(err);
    });

    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

/** 带超时的 fetch；将 AbortError / 网络错误映射为 AdapterLocalError。 不把 URL、请求头或响应正文写入错误消息。 */
export async function adapterFetch(
  url: string,
  options: AdapterRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const timeoutMessage = options.timeoutMessage ?? "请求外部服务超时";
  const networkMessage = options.networkMessage ?? "无法连接外部服务";
  const insecureTls = options.insecureTls ?? DEFAULT_ADAPTER_INSECURE_TLS;

  // 未注入自定义 fetch 时走 node:http(s)，HTTPS 默认可跳过证书校验（与 Probe 一致）
  if (options.fetchImpl === undefined && injectedFetch === undefined) {
    try {
      return await nodeAdapterRequest(url, {
        method: options.method ?? "GET",
        timeoutMs,
        deadlineMs: Date.now() + timeoutMs,
        insecureTls,
        maxBytes: options.maxBytes ?? DEFAULT_ADAPTER_RESPONSE_MAX_BYTES,
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
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
    }
  }

  const fetchImpl = options.fetchImpl ?? getAdapterFetch();
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
