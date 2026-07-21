/**
 * 站点图标出网抓取。
 * - 放行内网
 * - 忽略 TLS 证书错误（仅此路径）
 * - 仅跟随同 host 重定向
 * - 匿名，不带 Cookie
 */
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

import {
  isSameHost,
  type DiscoveredIconRef,
} from "@homepage/domain";

export const ICON_FETCH_TIMEOUT_MS = 15_000;
export const ICON_HTML_MAX_BYTES = 2 * 1024 * 1024;
export const ICON_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ICON_MAX_REDIRECTS = 5;
export const ICON_MAX_CANDIDATES = 12;

export type IconHttpResult =
  | {
      ok: true;
      statusCode: number;
      url: string;
      headers: http.IncomingHttpHeaders;
      body: Uint8Array;
    }
  | {
      ok: false;
      kind: "timeout" | "network" | "too_large" | "redirect" | "http";
      message: string;
      statusCode?: number;
    };

export type IconFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** 测试注入 */
  requestImpl?: typeof requestOnce;
};

type RequestOnceResult =
  | {
      kind: "response";
      statusCode: number;
      headers: http.IncomingHttpHeaders;
      body: Uint8Array;
      url: string;
    }
  | {
      kind: "redirect";
      location: string;
      statusCode: number;
      url: string;
    }
  | {
      kind: "error";
      errorKind: "timeout" | "network" | "too_large";
      message: string;
    };

function headersToRecord(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export function requestOnce(
  targetUrl: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    method?: string;
  },
): Promise<RequestOnceResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RequestOnceResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      finish({
        kind: "error",
        errorKind: "network",
        message: "无效的目标 URL",
      });
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      finish({
        kind: "error",
        errorKind: "network",
        message: "仅支持 http/https",
      });
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
          "User-Agent": "homepage-icon-fetch/0.1",
          "Accept-Encoding": "identity",
        },
        timeout: options.timeoutMs,
        // 取图路径忽略证书错误（ADR 0001）
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (
          status >= 300 &&
          status < 400 &&
          typeof location === "string" &&
          location.length > 0
        ) {
          res.resume();
          finish({
            kind: "redirect",
            location,
            statusCode: status,
            url: targetUrl,
          });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          total += chunk.length;
          if (total > options.maxBytes) {
            aborted = true;
            req.destroy();
            res.destroy();
            finish({
              kind: "error",
              errorKind: "too_large",
              message: "响应体超过大小上限",
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted || settled) return;
          finish({
            kind: "response",
            statusCode: status,
            headers: res.headers,
            body: new Uint8Array(Buffer.concat(chunks)),
            url: targetUrl,
          });
        });
        res.on("error", () => {
          if (settled) return;
          finish({
            kind: "error",
            errorKind: "network",
            message: "读取响应失败",
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      finish({
        kind: "error",
        errorKind: "timeout",
        message: "请求外部站点超时",
      });
    });
    req.on("error", () => {
      finish({
        kind: "error",
        errorKind: "network",
        message: "无法连接目标站点",
      });
    });
    req.end();
  });
}

/**
 * GET url，仅跟随同 host 重定向。
 */
export async function fetchIconResource(
  startUrl: string,
  options: IconFetchOptions = {},
): Promise<IconHttpResult> {
  const timeoutMs = options.timeoutMs ?? ICON_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? ICON_IMAGE_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? ICON_MAX_REDIRECTS;
  const doRequest = options.requestImpl ?? requestOnce;

  let current = startUrl;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const result = await doRequest(current, { timeoutMs, maxBytes });
    if (result.kind === "error") {
      return {
        ok: false,
        kind: result.errorKind,
        message: result.message,
      };
    }
    if (result.kind === "redirect") {
      let next: string;
      try {
        next = new URL(result.location, result.url).href;
      } catch {
        return {
          ok: false,
          kind: "redirect",
          message: "重定向地址无效",
          statusCode: result.statusCode,
        };
      }
      if (!isSameHost(startUrl, next)) {
        return {
          ok: false,
          kind: "redirect",
          message: "拒绝跨主机重定向",
          statusCode: result.statusCode,
        };
      }
      current = next;
      continue;
    }

    // response
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return {
        ok: false,
        kind: "http",
        message: `目标返回 HTTP ${result.statusCode}`,
        statusCode: result.statusCode,
      };
    }
    return {
      ok: true,
      statusCode: result.statusCode,
      url: result.url,
      headers: result.headers,
      body: result.body,
    };
  }

  return {
    ok: false,
    kind: "redirect",
    message: "重定向次数过多",
  };
}

export function contentTypeHint(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  const raw = headersToRecord(headers)["content-type"];
  if (!raw) return undefined;
  return raw.split(";")[0]?.trim().toLowerCase();
}

export type ResolvedCandidateBytes = {
  ref: DiscoveredIconRef;
  bytes: Uint8Array;
};

/**
 * 按发现顺序尝试下载候选，跳过失败项；最多保留 maxKeep 张合法图片字节（调用方再验魔法头）。
 */
export async function downloadCandidateBodies(
  refs: DiscoveredIconRef[],
  options: IconFetchOptions & { maxKeep?: number } = {},
): Promise<ResolvedCandidateBytes[]> {
  const maxKeep = options.maxKeep ?? ICON_MAX_CANDIDATES;
  const out: ResolvedCandidateBytes[] = [];
  for (const ref of refs) {
    if (out.length >= maxKeep) break;
    const result = await fetchIconResource(ref.href, {
      ...options,
      maxBytes: options.maxBytes ?? ICON_IMAGE_MAX_BYTES,
    });
    if (!result.ok) continue;
    if (result.body.length === 0) continue;
    out.push({ ref, bytes: result.body });
  }
  return out;
}
