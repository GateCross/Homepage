import * as http from "node:http";
import * as https from "node:https";

import type { HttpUnreachableReason } from "@homepage/domain";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HttpLocalError extends Error {
  readonly localMessage: string;
  readonly kind: "timeout" | "network" | "other";
  readonly unreachableReason: HttpUnreachableReason;

  constructor(
    localMessage: string,
    kind: "timeout" | "network" | "other",
    unreachableReason: HttpUnreachableReason,
  ) {
    super(localMessage);
    this.name = "HttpLocalError";
    this.localMessage = localMessage;
    this.kind = kind;
    this.unreachableReason = unreachableReason;
  }
}

let injectedFetch: FetchLike | undefined;

export function setServerFetch(fetchImpl: FetchLike | undefined): void {
  injectedFetch = fetchImpl;
}

export function getServerFetch(): FetchLike {
  if (injectedFetch !== undefined) {
    return injectedFetch;
  }
  if (typeof globalThis.fetch !== "function") {
    throw new HttpLocalError(
      "当前运行环境不支持网络请求",
      "other",
      "other",
    );
  }
  return globalThis.fetch.bind(globalThis) as FetchLike;
}

type ErrorChainItem = {
  name: string;
  code: string;
  message: string;
};

/** 展开 error.cause 链，Node fetch 常把真实网络/TLS 错误挂在 cause 上 */
function collectErrorChain(err: unknown): ErrorChainItem[] {
  const chain: ErrorChainItem[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const name =
        "name" in current ? String((current as { name: unknown }).name) : "";
      const code =
        "code" in current ? String((current as { code: unknown }).code) : "";
      const message =
        current instanceof Error
          ? current.message
          : "message" in current
            ? String((current as { message: unknown }).message)
            : "";
      chain.push({ name, code, message });
      current =
        "cause" in current
          ? (current as { cause: unknown }).cause
          : undefined;
    } else if (typeof current === "string") {
      chain.push({ name: "", code: "", message: current });
      break;
    } else {
      break;
    }
  }

  return chain;
}

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_UNTRUSTED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

export function classifyNetworkError(err: unknown): {
  kind: "timeout" | "network" | "other";
  reason: HttpUnreachableReason;
  message: string;
} {
  if (err instanceof HttpLocalError) {
    return {
      kind: err.kind,
      reason: err.unreachableReason,
      message: err.localMessage,
    };
  }

  const chain = collectErrorChain(err);
  const blob = chain
    .map((item) => `${item.name} ${item.code} ${item.message}`)
    .join(" ")
    .toLowerCase();
  const codes = new Set(chain.map((item) => item.code));
  const names = new Set(chain.map((item) => item.name));

  if (
    names.has("AbortError") ||
    names.has("TimeoutError") ||
    codes.has("ABORT_ERR") ||
    blob.includes("aborted") ||
    blob.includes("timeout") ||
    blob.includes("timed out")
  ) {
    return {
      kind: "timeout",
      reason: "timeout",
      message: "请求外部服务超时",
    };
  }

  if (
    codes.has("ENOTFOUND") ||
    codes.has("EAI_AGAIN") ||
    blob.includes("getaddrinfo") ||
    blob.includes("enotfound") ||
    /\bdns\b/.test(blob)
  ) {
    return {
      kind: "network",
      reason: "dns",
      message: "无法解析目标主机名",
    };
  }

  if (
    [...codes].some((code) => TLS_ERROR_CODES.has(code)) ||
    blob.includes("certificate") ||
    blob.includes("cert_") ||
    blob.includes("self signed") ||
    blob.includes("self-signed") ||
    blob.includes("unable to verify") ||
    /\bssl\b/.test(blob) ||
    /\btls\b/.test(blob)
  ) {
    return {
      kind: "network",
      reason: "tls",
      message: "TLS 握手或证书校验失败",
    };
  }

  if (
    codes.has("ECONNREFUSED") ||
    codes.has("ECONNRESET") ||
    codes.has("EHOSTUNREACH") ||
    codes.has("ENETUNREACH") ||
    codes.has("EPIPE") ||
    blob.includes("econnrefused") ||
    blob.includes("econnreset")
  ) {
    return {
      kind: "network",
      reason: "connect",
      message: "无法连接到目标服务",
    };
  }

  return {
    kind: "network",
    reason: "other",
    message: "无法连接外部服务",
  };
}

export type TimedFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;

  redirect?: "follow" | "error" | "manual";
  /** 跳过 TLS 证书校验；内网自签/IP 证书探测用 */
  insecureTls?: boolean;
};

/** 使用 node:http(s) 发请求，支持 rejectUnauthorized=false */
function nodeTimedRequest(
  url: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    insecureTls: boolean;
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(
        new HttpLocalError("目标 URL 无效", "other", "other"),
      );
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(
        new HttpLocalError("仅支持 http/https 探测", "other", "other"),
      );
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
        timeout: options.timeoutMs,
        ...(isHttps ? { rejectUnauthorized: !options.insecureTls } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        res.on("end", () => {
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
          resolve(
            new Response(body, {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers,
            }),
          );
        });
        res.on("error", (err) => {
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

export async function timedFetch(
  url: string,
  options: TimedFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const method = options.method ?? "GET";
  const insecureTls = options.insecureTls === true;

  // 跳过证书校验时走 node:http(s)；否则优先用注入/全局 fetch
  if (insecureTls && options.fetchImpl === undefined) {
    try {
      return await nodeTimedRequest(url, {
        method,
        timeoutMs,
        insecureTls: true,
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
    } catch (err) {
      if (err instanceof HttpLocalError) {
        throw err;
      }
      const classified = classifyNetworkError(err);
      throw new HttpLocalError(
        classified.message,
        classified.kind,
        classified.reason,
      );
    }
  }

  const fetchImpl = options.fetchImpl ?? getServerFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const init: RequestInit = {
      method,
      signal: controller.signal,
      redirect: options.redirect ?? "follow",
    };
    if (options.headers !== undefined) {
      init.headers = options.headers;
    }
    if (options.body !== undefined) {
      init.body = options.body;
    }
    return await fetchImpl(url, init);
  } catch (err) {
    const classified = classifyNetworkError(err);
    throw new HttpLocalError(
      classified.message,
      classified.kind,
      classified.reason,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonResponse(
  response: Response,
  invalidMessage = "外部服务返回了无效的 JSON",
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new HttpLocalError("读取外部服务响应失败", "other", "other");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpLocalError(invalidMessage, "other", "other");
  }
}
