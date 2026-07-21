import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import type { Context } from "hono";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const COMPRESSIBLE_EXT = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".map",
  ".txt",
  ".webmanifest",
]);

/** 进程内 gzip 缓存：key=绝对路径 */
const gzipCache = new Map<
  string,
  { mtimeMs: number; size: number; body: Buffer }
>();

export function resolveDefaultWebDistDir(
  metaUrl: string = import.meta.url,
): string {
  const here = path.dirname(fileURLToPath(metaUrl));
  return path.resolve(here, "../../../apps/web/dist");
}

export function assertWebDistReady(webDistDir: string): void {
  if (!existsSync(webDistDir) || !statSync(webDistDir).isDirectory()) {
    throw new Error(
      `前端生产目录不存在：${webDistDir}。请先执行根目录 pnpm build 生成 apps/web/dist。`,
    );
  }
  const indexPath = path.join(webDistDir, "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error(
      `前端入口文件缺失：${indexPath}。请先执行根目录 pnpm build 生成完整前端产物。`,
    );
  }
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function safeJoinUnderRoot(rootDir: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(rootDir, relative);
  const rootResolved = path.resolve(rootDir);
  if (
    candidate !== rootResolved &&
    !candidate.startsWith(rootResolved + path.sep)
  ) {
    return null;
  }
  return candidate;
}

function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (acceptEncoding === undefined || acceptEncoding.trim() === "") {
    return false;
  }
  return /(?:^|,)\s*gzip(?:\s|;|,|$)/i.test(acceptEncoding);
}

function fileResponse(
  filePath: string,
  status = 200,
  acceptEncoding?: string,
): Response {
  const stat = statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const cacheControl = filePath.endsWith(".html")
    ? "no-cache"
    : "public, max-age=31536000, immutable";
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": cacheControl,
    Vary: "Accept-Encoding",
  };

  const canGzip =
    acceptsGzip(acceptEncoding) &&
    COMPRESSIBLE_EXT.has(ext) &&
    stat.size >= 1024;

  if (canGzip) {
    const hit = gzipCache.get(filePath);
    let body: Buffer;
    if (
      hit !== undefined &&
      hit.mtimeMs === stat.mtimeMs &&
      hit.size === stat.size
    ) {
      body = hit.body;
    } else {
      const raw = readFileSync(filePath);
      body = gzipSync(raw, { level: 6 });
      gzipCache.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        body,
      });
    }
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = String(body.byteLength);
    return new Response(new Uint8Array(body), { status, headers });
  }

  const stream = createReadStream(filePath);
  const body = Readable.toWeb(stream) as unknown as import("node:stream/web").ReadableStream;
  headers["Content-Length"] = String(stat.size);
  return new Response(body as unknown as ConstructorParameters<typeof Response>[0], {
    status,
    headers,
  });
}

function tryServeFileUnderRoot(
  rootDir: string,
  urlPath: string,
  acceptEncoding?: string,
): Response | null {
  const filePath = safeJoinUnderRoot(rootDir, urlPath);
  if (filePath === null) {
    return null;
  }
  if (!existsSync(filePath)) {
    return null;
  }
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    const nestedIndex = path.join(filePath, "index.html");
    if (existsSync(nestedIndex) && statSync(nestedIndex).isFile()) {
      return fileResponse(nestedIndex, 200, acceptEncoding);
    }
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  return fileResponse(filePath, 200, acceptEncoding);
}

const CONFIG_ASSET_PREFIXES = ["/images/", "/icons/"] as const;

export function tryServeConfigAsset(
  configDir: string,
  urlPath: string,
  acceptEncoding?: string,
): Response | null {
  const matched = CONFIG_ASSET_PREFIXES.some((prefix) =>
    urlPath.startsWith(prefix),
  );
  if (!matched) {
    return null;
  }
  return tryServeFileUnderRoot(configDir, urlPath, acceptEncoding);
}

export function createStaticHandlers(webDistDir: string): {
  tryServeStatic: (c: Context) => Response | null;
  serveSpaIndex: (c: Context) => Response;
} {
  const indexPath = path.join(webDistDir, "index.html");

  const tryServeStatic = (c: Context): Response | null => {
    const urlPath = c.req.path;
    if (urlPath === "/" || urlPath === "") {
      return null;
    }
    const acceptEncoding = c.req.header("accept-encoding") ?? undefined;
    return tryServeFileUnderRoot(webDistDir, urlPath, acceptEncoding);
  };

  const serveSpaIndex = (c: Context): Response => {
    const acceptEncoding = c.req.header("accept-encoding") ?? undefined;
    return fileResponse(indexPath, 200, acceptEncoding);
  };

  return { tryServeStatic, serveSpaIndex };
}
