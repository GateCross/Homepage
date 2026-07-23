import { Hono } from "hono";

import {
  ApiSuccessSchemas,
  createConfigInvalidError,
  createExternalFailureError,
  createExternalTimeoutError,
  createInternalError,
  createApiNotFoundError,
} from "@homepage/domain";

import { toErrorResponse, toJsonResponse } from "../errors.js";
import { HttpLocalError, timedFetch } from "../http-utils.js";
import { logError } from "../log.js";
import {
  createIconService,
  type IconService,
  type IconServiceError,
} from "../icons/service.js";

/** Iconify CDN 代理：前端经本站拉取，避免浏览器直连 CDN 在离线/阻断时失败 */
const ICONIFY_PROXY_PREFIX = "https://api.iconify.design";
const ICONIFY_ALLOWED_PREFIXES = new Set(["mdi", "simple-icons"]);
const ICONIFY_PROXY_TIMEOUT_MS = 10_000;
const ICONIFY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

export type IconsRouteDeps = {
  getConfigDir: () => string;
  iconService?: IconService;
};

function errorToResponse(err: IconServiceError) {
  switch (err.code) {
    case "invalid_url":
    case "no_candidates":
      return toErrorResponse(createConfigInvalidError(err.message));
    case "timeout":
      return toErrorResponse(createExternalTimeoutError(err.message));
    case "external":
      return toErrorResponse(createExternalFailureError(err.message));
    case "session_expired":
    case "candidate_missing":
      return toErrorResponse(
        createApiNotFoundError(err.message),
      );
    case "write_failed":
      return toErrorResponse(createInternalError(err.message));
    default: {
      const _e: never = err.code;
      void _e;
      return toErrorResponse(createInternalError(err.message));
    }
  }
}

export function createIconsRoutes(deps: IconsRouteDeps): Hono {
  const app = new Hono();
  const service =
    deps.iconService ??
    createIconService({ getConfigDir: deps.getConfigDir });

  app.post("/icons/resolve", async (c) => {
    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return toErrorResponse(
          createConfigInvalidError("请求体必须为 JSON"),
        );
      }
      const url =
        body !== null &&
        typeof body === "object" &&
        "url" in body &&
        typeof (body as { url: unknown }).url === "string"
          ? (body as { url: string }).url
          : "";

      const result = await service.resolve(url);
      if (!result.ok) {
        return errorToResponse(result.error);
      }
      const parsed = ApiSuccessSchemas.iconResolve.parse(result.body);
      return toJsonResponse(parsed, 200);
    } catch (err) {
      logError("api/icons/resolve", "解析站点图标失败");
      void err;
      return toErrorResponse(
        createInternalError("解析站点图标失败，请稍后重试"),
      );
    }
  });

  app.post("/icons/import", async (c) => {
    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return toErrorResponse(
          createConfigInvalidError("请求体必须为 JSON"),
        );
      }
      const sessionId =
        body !== null &&
        typeof body === "object" &&
        "sessionId" in body &&
        typeof (body as { sessionId: unknown }).sessionId === "string"
          ? (body as { sessionId: string }).sessionId
          : "";
      const candidateId =
        body !== null &&
        typeof body === "object" &&
        "candidateId" in body &&
        typeof (body as { candidateId: unknown }).candidateId === "string"
          ? (body as { candidateId: string }).candidateId
          : "";

      const result = await service.import({ sessionId, candidateId });
      if (!result.ok) {
        return errorToResponse(result.error);
      }
      const parsed = ApiSuccessSchemas.iconImport.parse(result.body);
      return toJsonResponse(parsed, 200);
    } catch (err) {
      logError("api/icons/import", "导入站点图标失败");
      void err;
      return toErrorResponse(
        createInternalError("导入站点图标失败，请稍后重试"),
      );
    }
  });

  // GET /api/icons/iconify/:prefix/:name.svg — 代理 Iconify SVG
  app.get("/icons/iconify/:prefix/:name", async (c) => {
    try {
      const prefix = c.req.param("prefix").trim().toLowerCase();
      let nameParam = c.req.param("name").trim();
      if (nameParam.toLowerCase().endsWith(".svg")) {
        nameParam = nameParam.slice(0, -4);
      }
      if (!ICONIFY_ALLOWED_PREFIXES.has(prefix)) {
        return toErrorResponse(createApiNotFoundError("不支持的图标集"));
      }
      if (!ICONIFY_NAME_RE.test(nameParam)) {
        return toErrorResponse(createConfigInvalidError("图标名称无效"));
      }

      const upstream = `${ICONIFY_PROXY_PREFIX}/${prefix}/${encodeURIComponent(nameParam)}.svg`;
      let response: Response;
      try {
        response = await timedFetch(upstream, {
          method: "GET",
          timeoutMs: ICONIFY_PROXY_TIMEOUT_MS,
          headers: {
            Accept: "image/svg+xml,*/*",
            "User-Agent": "Homepage-Iconify-Proxy/1.0",
          },
        });
      } catch (err) {
        if (err instanceof HttpLocalError) {
          if (err.kind === "timeout") {
            return toErrorResponse(createExternalTimeoutError("图标源请求超时"));
          }
          return toErrorResponse(
            createExternalFailureError("无法连接图标源"),
          );
        }
        throw err;
      }

      if (!response.ok) {
        if (response.status === 404) {
          return toErrorResponse(createApiNotFoundError("图标不存在"));
        }
        return toErrorResponse(
          createExternalFailureError("图标源返回异常状态"),
        );
      }

      const body = await response.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (err) {
      logError("api/icons/iconify", "代理 Iconify 图标失败");
      void err;
      return toErrorResponse(
        createInternalError("获取图标失败，请稍后重试"),
      );
    }
  });

  return app;
}
