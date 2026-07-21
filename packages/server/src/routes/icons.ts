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
import { logError } from "../log.js";
import {
  createIconService,
  type IconService,
  type IconServiceError,
} from "../icons/service.js";

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

  return app;
}
