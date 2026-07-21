import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";

import {
  ApiSuccessSchemas,
  createConfigInvalidError,
  createInternalError,
} from "@homepage/domain";

import { toErrorResponse, toJsonResponse } from "../errors.js";
import { logError } from "../log.js";

export type AssetsRouteDeps = {
  getConfigDir: () => string;
};

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

const EXT_FROM_NAME: Record<string, string> = {
  ".jpg": ".jpg",
  ".jpeg": ".jpg",
  ".png": ".png",
  ".webp": ".webp",
  ".gif": ".gif",
  ".svg": ".svg",
  ".ico": ".ico",
};

function sanitizeOriginalBase(name: string): string {
  const base = path.basename(name).replace(/\.[^.]+$/, "");
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : "image";
}

function resolveExtension(file: File): string | null {
  const mime = (file.type || "").toLowerCase().trim();
  if (mime in ALLOWED_MIME_TO_EXT) {
    return ALLOWED_MIME_TO_EXT[mime]!;
  }
  const ext = path.extname(file.name || "").toLowerCase();
  return EXT_FROM_NAME[ext] ?? null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

function magicMatches(ext: string, bytes: Uint8Array): boolean {
  if (bytes.length < 4) {
    return false;
  }
  if (ext === ".jpg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (ext === ".png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    );
  }
  if (ext === ".gif") {
    return (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    );
  }
  if (ext === ".webp") {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  if (ext === ".ico") {
    return bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00;
  }
  if (ext === ".svg") {
    return looksLikeSvg(bytes);
  }
  return false;
}

export function createAssetsRoutes(deps: AssetsRouteDeps): Hono {
  const app = new Hono();

  app.post("/assets/upload", async (c) => {
    try {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return toErrorResponse(
          createConfigInvalidError("请求必须为 multipart/form-data"),
        );
      }

      const entry = form.get("file");
      if (!(entry instanceof File)) {
        return toErrorResponse(
          createConfigInvalidError("请选择要上传的图片文件（字段名 file）"),
        );
      }

      if (entry.size <= 0) {
        return toErrorResponse(createConfigInvalidError("上传文件为空"));
      }
      if (entry.size > MAX_UPLOAD_BYTES) {
        return toErrorResponse(
          createConfigInvalidError("图片不能超过 5MB"),
        );
      }

      const ext = resolveExtension(entry);
      if (ext === null) {
        return toErrorResponse(
          createConfigInvalidError(
            "仅支持 jpg、png、webp、gif、svg、ico 图片",
          ),
        );
      }

      const buffer = new Uint8Array(await entry.arrayBuffer());
      if (!magicMatches(ext, buffer)) {
        return toErrorResponse(
          createConfigInvalidError("文件内容与图片类型不匹配"),
        );
      }

      const configDir = deps.getConfigDir();
      const imagesDir = path.join(configDir, "images");
      await mkdir(imagesDir, { recursive: true });

      const stamp = Date.now().toString(36);
      const rand = randomBytes(4).toString("hex");
      const base = sanitizeOriginalBase(entry.name || "image");
      const filename = `${base}-${stamp}-${rand}${ext}`;
      const absolutePath = path.join(imagesDir, filename);

      // 再次确认落点仍在 images 目录内
      const resolved = path.resolve(absolutePath);
      const imagesResolved = path.resolve(imagesDir);
      if (
        resolved !== imagesResolved &&
        !resolved.startsWith(imagesResolved + path.sep)
      ) {
        return toErrorResponse(createInternalError("资源路径校验失败"));
      }

      await writeFile(resolved, buffer, { mode: 0o644 });

      const publicPath = `/images/${filename}`;
      const body = ApiSuccessSchemas.assetUpload.parse({
        ok: true as const,
        path: publicPath,
        filename,
      });
      return toJsonResponse(body, 200);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logError("api/assets/upload", "上传图片失败", [], { detail });
      const message =
        detail.includes("EACCES") || detail.includes("permission denied")
          ? "上传图片失败：配置目录无写权限，请检查 Docker 挂载的 config/images 权限"
          : "上传图片失败，请稍后重试";
      return toErrorResponse(createInternalError(message));
    }
  });

  return app;
}
