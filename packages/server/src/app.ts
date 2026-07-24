import { Hono } from "hono";

import type { runServiceWidget } from "@homepage/adapters";
import type { LoadConfigOptions, loadConfig } from "@homepage/config";
import {
  createApiNotFoundError,
  createInternalError,
  isApiPath,
} from "@homepage/domain";

import type { queryDockerStatus } from "./docker/status.js";
import { mapErrorToApiResponse, toErrorResponse, toJsonResponse } from "./errors.js";
import { resolveServerEnv, type ServerEnv } from "./env.js";
import { logError } from "./log.js";
import type { runHttpProbe } from "./probe.js";
import type { fetchOpenMeteoInfo } from "./providers/openmeteo.js";
import type { collectResourcesInfo } from "./providers/resources.js";
import { createAssetsRoutes } from "./routes/assets.js";
import { createConfigRoutes } from "./routes/config.js";
import { createDockerRoutes } from "./routes/docker.js";
import { createIconsRoutes } from "./routes/icons.js";
import { createInfoRoutes } from "./routes/info.js";
import { createProbeRoutes } from "./routes/probe.js";
import { createWidgetsRoutes } from "./routes/widgets.js";
import {
  assertWebDistReady,
  createStaticHandlers,
  resolveDefaultWebDistDir,
  tryServeConfigAsset,
} from "./static.js";
import { buildVersionResponse } from "./version.js";

export type CreateAppOptions = {
  env?: Partial<ServerEnv>;
  getLoadOptions?: () => LoadConfigOptions;
  loadConfigImpl?: typeof loadConfig;
  runProbe?: typeof runHttpProbe;
  queryStatus?: typeof queryDockerStatus;
  runWidget?: typeof runServiceWidget;
  fetchOpenMeteo?: typeof fetchOpenMeteoInfo;
  collectResources?: typeof collectResourcesInfo;
  /** 前端 dist；`false` 表示不挂载静态资源（dev / 测试） */
  webDistDir?: string | false;
  /** 生产启动时要求 dist 就绪；缺省：webDistDir !== false */
  requireWebDist?: boolean;
};

export function createApp(options: CreateAppOptions = {}): {
  app: Hono;
  env: ServerEnv;
} {
  const env = resolveServerEnv(options.env);
  const getLoadOptions =
    options.getLoadOptions ??
    ((): LoadConfigOptions => ({ configDir: env.configDir }));

  let webDistDir: string | null = null;
  if (options.webDistDir === false) {
    webDistDir = null;
  } else if (typeof options.webDistDir === "string") {
    webDistDir = options.webDistDir;
  } else {
    webDistDir = resolveDefaultWebDistDir();
  }

  const requireWebDist =
    options.requireWebDist ?? options.webDistDir !== false;
  if (requireWebDist && webDistDir !== null) {
    assertWebDistReady(webDistDir);
  } else if (webDistDir !== null) {
    try {
      assertWebDistReady(webDistDir);
    } catch {
      webDistDir = null;
    }
  }

  const app = new Hono();

  app.get("/api/health", (c) =>
    toJsonResponse({ ok: true, service: "@homepage/server" }, 200),
  );

  app.get("/api/version", async (c) => {
    try {
      // check=0：仅本地版本（缓存命中时可带更新信息），不发起出网
      const checkParam = c.req.query("check");
      const checkRemote = checkParam !== "0" && checkParam !== "false";
      const body = await buildVersionResponse({ checkRemote });
      return toJsonResponse(body, 200);
    } catch (err) {
      logError(
        "server",
        `版本检查失败：${err instanceof Error ? err.message : String(err)}`,
      );
      const mapped = mapErrorToApiResponse(err);
      return toErrorResponse(mapped);
    }
  });

  const shared = {
    getLoadOptions,
    ...(options.loadConfigImpl !== undefined
      ? { loadConfigImpl: options.loadConfigImpl }
      : {}),
  };

  app.route(
    "/api",
    createConfigRoutes(shared),
  );
  app.route(
    "/api",
    createAssetsRoutes({
      getConfigDir: () => env.configDir,
    }),
  );
  app.route(
    "/api",
    createIconsRoutes({
      getConfigDir: () => env.configDir,
    }),
  );
  app.route(
    "/api",
    createProbeRoutes({
      ...shared,
      ...(options.runProbe !== undefined ? { runProbe: options.runProbe } : {}),
    }),
  );
  app.route(
    "/api",
    createDockerRoutes({
      ...shared,
      ...(options.queryStatus !== undefined
        ? { queryStatus: options.queryStatus }
        : {}),
    }),
  );
  app.route(
    "/api",
    createWidgetsRoutes({
      ...shared,
      ...(options.runWidget !== undefined ? { runWidget: options.runWidget } : {}),
    }),
  );
  app.route(
    "/api",
    createInfoRoutes({
      ...shared,
      ...(options.fetchOpenMeteo !== undefined
        ? { fetchOpenMeteo: options.fetchOpenMeteo }
        : {}),
      ...(options.collectResources !== undefined
        ? { collectResources: options.collectResources }
        : {}),
    }),
  );

  const staticHandlers =
    webDistDir !== null ? createStaticHandlers(webDistDir) : null;

  app.notFound((c) => {
    const reqPath = c.req.path;
    if (isApiPath(reqPath)) {
      return toErrorResponse(createApiNotFoundError());
    }

    const acceptEncoding = c.req.header("accept-encoding") ?? undefined;
    const configAsset = tryServeConfigAsset(
      env.configDir,
      reqPath,
      acceptEncoding,
    );
    if (configAsset !== null) {
      return configAsset;
    }

    if (staticHandlers !== null) {
      const staticRes = staticHandlers.tryServeStatic(c);
      if (staticRes !== null) {
        return staticRes;
      }
      return staticHandlers.serveSpaIndex(c);
    }

    return c.text("Homepage API（未挂载前端静态资源）", 404);
  });

  app.onError((err, c) => {
    // 不写原始异常文案，避免密钥进入日志；细节由 mapErrorToApiResponse 脱敏处理
    logError("hono", "请求处理失败");
    if (isApiPath(c.req.path)) {
      return toErrorResponse(mapErrorToApiResponse(err));
    }
    return toErrorResponse(createInternalError());
  });

  return { app, env };
}
