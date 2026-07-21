/**
 * Icon Resolve / Import 用例编排。
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  bytesToDataUrl,
  detectImageExtension,
  discoverIconRefsFromHtml,
  isHttpOrHttpsUrl,
  mergeIconDiscovery,
  mimeTypeForImageExt,
  type IconCandidate,
  type IconImportSuccessResponse,
  type IconResolveSuccessResponse,
} from "@homepage/domain";

import { logError } from "../log.js";
import {
  downloadCandidateBodies,
  fetchIconResource,
  ICON_FETCH_TIMEOUT_MS,
  ICON_HTML_MAX_BYTES,
  ICON_IMAGE_MAX_BYTES,
  ICON_MAX_CANDIDATES,
  type IconFetchOptions,
} from "./fetch.js";
import {
  createIconSessionStore,
  newCandidateId,
  type CachedIconCandidate,
  type IconSessionStore,
} from "./session.js";

export type IconServiceError = {
  code:
    | "invalid_url"
    | "no_candidates"
    | "timeout"
    | "external"
    | "session_expired"
    | "candidate_missing"
    | "write_failed";
  message: string;
};

export type IconResolveResult =
  | { ok: true; body: IconResolveSuccessResponse }
  | { ok: false; error: IconServiceError };

export type IconImportResult =
  | { ok: true; body: IconImportSuccessResponse }
  | { ok: false; error: IconServiceError };

export type IconService = {
  resolve(sourceUrl: string): Promise<IconResolveResult>;
  import(input: {
    sessionId: string;
    candidateId: string;
  }): Promise<IconImportResult>;
};

export type CreateIconServiceOptions = {
  getConfigDir: () => string;
  sessionStore?: IconSessionStore;
  fetchOptions?: IconFetchOptions;
};

function sanitizeBase(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : "site-icon";
}

function hostBase(sourceUrl: string): string {
  try {
    return sanitizeBase(new URL(sourceUrl).hostname || "site-icon");
  } catch {
    return "site-icon";
  }
}

export function createIconService(
  options: CreateIconServiceOptions,
): IconService {
  const store = options.sessionStore ?? createIconSessionStore();
  const fetchOpts = options.fetchOptions ?? {};

  return {
    async resolve(rawUrl) {
      const sourceUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (!isHttpOrHttpsUrl(sourceUrl)) {
        return {
          ok: false,
          error: {
            code: "invalid_url",
            message: "请提供有效的 http(s) 链接作为取图源地址",
          },
        };
      }

      let pageHtml = "";
      let pageUrl = sourceUrl;
      const pageResult = await fetchIconResource(sourceUrl, {
        ...fetchOpts,
        timeoutMs: fetchOpts.timeoutMs ?? ICON_FETCH_TIMEOUT_MS,
        maxBytes: fetchOpts.maxBytes ?? ICON_HTML_MAX_BYTES,
      });

      if (pageResult.ok) {
        pageUrl = pageResult.url;
        pageHtml = new TextDecoder("utf-8", { fatal: false }).decode(
          pageResult.body,
        );
      } else if (pageResult.kind === "timeout") {
        // HTML 超时仍尝试静态回退
        pageHtml = "";
      } else {
        // 其它失败也继续静态回退（登录墙、404 等）
        pageHtml = "";
      }

      const fromHtml =
        pageHtml.length > 0
          ? discoverIconRefsFromHtml(pageHtml, pageUrl)
          : [];
      const refs = mergeIconDiscovery(fromHtml, pageUrl);

      const downloaded = await downloadCandidateBodies(refs, {
        ...fetchOpts,
        timeoutMs: fetchOpts.timeoutMs ?? ICON_FETCH_TIMEOUT_MS,
        maxBytes: ICON_IMAGE_MAX_BYTES,
        maxKeep: ICON_MAX_CANDIDATES,
      });

      const cached: CachedIconCandidate[] = [];
      const publicCandidates: IconCandidate[] = [];

      for (const item of downloaded) {
        const ext = detectImageExtension(item.bytes);
        if (ext === null) continue;
        const candidateId = newCandidateId();
        const contentType = mimeTypeForImageExt(ext);
        const entry: CachedIconCandidate = {
          candidateId,
          tier: item.ref.tier,
          ext,
          contentType,
          bytes: item.bytes,
        };
        if (item.ref.declaredSizes) {
          entry.declaredSizes = item.ref.declaredSizes;
        }
        if (item.ref.declaredType) {
          entry.declaredType = item.ref.declaredType;
        }
        cached.push(entry);

        const previewDataUrl = bytesToDataUrl(item.bytes, ext);
        const pub: IconCandidate = {
          candidateId,
          tier: item.ref.tier,
          contentType,
          byteLength: item.bytes.byteLength,
          previewDataUrl,
        };
        if (item.ref.declaredSizes) pub.declaredSizes = item.ref.declaredSizes;
        if (item.ref.declaredType) pub.declaredType = item.ref.declaredType;
        publicCandidates.push(pub);
      }

      if (publicCandidates.length === 0) {
        const hint =
          pageResult.ok === false && pageResult.kind === "timeout"
            ? "请求超时且未找到可用站点图标"
            : "未找到可用的站点图标";
        return {
          ok: false,
          error: {
            code: "no_candidates",
            message: hint,
          },
        };
      }

      const session = store.create(sourceUrl, cached);
      const body: IconResolveSuccessResponse = {
        ok: true,
        sourceUrl,
        sessionId: session.sessionId,
        candidates: publicCandidates,
      };
      return { ok: true, body };
    },

    async import(input) {
      const sessionId = input.sessionId?.trim() ?? "";
      const candidateId = input.candidateId?.trim() ?? "";
      if (!sessionId || !candidateId) {
        return {
          ok: false,
          error: {
            code: "candidate_missing",
            message: "缺少会话或候选标识",
          },
        };
      }

      const session = store.get(sessionId);
      if (!session) {
        return {
          ok: false,
          error: {
            code: "session_expired",
            message: "取图会话已过期，请重新获取",
          },
        };
      }

      const candidate = store.takeCandidate(sessionId, candidateId);
      if (!candidate) {
        return {
          ok: false,
          error: {
            code: "candidate_missing",
            message: "候选不存在或已失效，请重新获取",
          },
        };
      }

      // 再次校验魔法头，防止会话被污染
      const ext = detectImageExtension(candidate.bytes);
      if (ext === null || ext !== candidate.ext) {
        return {
          ok: false,
          error: {
            code: "candidate_missing",
            message: "候选图片无效，请重新获取",
          },
        };
      }

      try {
        const configDir = options.getConfigDir();
        const imagesDir = path.join(configDir, "images");
        await mkdir(imagesDir, { recursive: true });

        const stamp = Date.now().toString(36);
        const rand = randomBytes(4).toString("hex");
        const base = hostBase(session.sourceUrl);
        const filename = `${base}-${stamp}-${rand}${ext}`;
        const absolutePath = path.join(imagesDir, filename);
        const resolved = path.resolve(absolutePath);
        const imagesResolved = path.resolve(imagesDir);
        if (
          resolved !== imagesResolved &&
          !resolved.startsWith(imagesResolved + path.sep)
        ) {
          return {
            ok: false,
            error: {
              code: "write_failed",
              message: "资源路径校验失败",
            },
          };
        }

        await writeFile(resolved, candidate.bytes, { mode: 0o644 });
        const publicPath = `/images/${filename}`;
        const body: IconImportSuccessResponse = {
          ok: true,
          path: publicPath,
          filename,
        };
        return { ok: true, body };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logError("icons/import", "保存图标失败", [], { detail });
        // 常见于 Docker 挂载 config 后，容器内非 root 用户无权写入 images/
        return {
          ok: false,
          error: {
            code: "write_failed",
            message:
              detail.includes("EACCES") || detail.includes("permission denied")
                ? "保存图标失败：配置目录无写权限，请检查 Docker 挂载的 config/images 权限"
                : "保存图标失败，请稍后重试",
          },
        };
      }
    },
  };
}
