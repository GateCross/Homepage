import { Hono } from "hono";

import {
  isConfigValidationError,
  loadConfig,
  type LoadConfigOptions,
} from "@homepage/config";
import {
  ApiSuccessSchemas,
  createConfigInvalidError,
  createExternalFailureError,
  createExternalTimeoutError,
  createForbiddenError,
  createInternalError,
} from "@homepage/domain";

import {
  queryDockerBatchStatus,
  queryDockerStatusCached,
} from "../docker/batch.js";
import type { DockerStatusCache } from "../docker/cache.js";
import { DockerClientError } from "../docker/client.js";
import {
  authorizeDockerEndpoint,
  authorizeDockerLookup,
  queryDockerContainers,
  queryDockerStatus,
} from "../docker/status.js";
import {
  mapErrorToApiResponse,
  toErrorResponse,
  toJsonResponse,
} from "../errors.js";
import { gatherSecrets, jsonContainsAnySecret } from "../secrets.js";
import { logError } from "../log.js";
import { ensureNotFaulted } from "./config.js";

export type DockerRouteDeps = {
  loadConfigImpl?: typeof loadConfig;
  getLoadOptions?: () => LoadConfigOptions;
  queryStatus?: typeof queryDockerStatus;
  queryContainers?: typeof queryDockerContainers;
  queryBatch?: typeof queryDockerBatchStatus;
  /** 测试可注入独立缓存；缺省用进程默认短 TTL 缓存 */
  statusCache?: DockerStatusCache;
};

function decodeParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function createDockerRoutes(deps: DockerRouteDeps = {}): Hono {
  const app = new Hono();
  const load = deps.loadConfigImpl ?? loadConfig;
  const query = deps.queryStatus ?? queryDockerStatus;
  const listContainers = deps.queryContainers ?? queryDockerContainers;
  const queryBatch = deps.queryBatch ?? queryDockerBatchStatus;
  const statusCache = deps.statusCache;

  // 批量状态：须在 /docker/:server/... 之前注册
  // ?stats=0|false → 仅 inspect（首屏徽章）；默认含 stats
  app.get("/docker/status", async (c) => {
    let allowListForError: Awaited<
      ReturnType<typeof load>
    >["allowList"] | undefined;
    try {
      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }
      const { allowList } = await load(options);
      allowListForError = allowList;

      const statsParam = c.req.query("stats");
      const includeStats =
        statsParam === undefined ||
        statsParam === "" ||
        !["0", "false", "no"].includes(statsParam.toLowerCase());

      const body = await queryBatch(allowList, {
        ...(statusCache !== undefined ? { cache: statusCache } : {}),
        includeStats,
      });

      // lite 返回后后台预热 full（stats），使前端第二阶段多半命中缓存
      if (!includeStats) {
        void queryBatch(allowList, {
          ...(statusCache !== undefined ? { cache: statusCache } : {}),
          includeStats: true,
        }).catch(() => {
          // 预热失败不影响当前响应
        });
      }

      const parsed = ApiSuccessSchemas.dockerBatch.parse(body);
      const secrets = gatherSecrets(allowList);
      if (jsonContainsAnySecret(parsed, secrets)) {
        logError("api/docker", "Docker 批量响应疑似包含敏感值", secrets);
        return toErrorResponse(createInternalError());
      }
      return toJsonResponse(parsed, 200);
    } catch (err) {
      if (isConfigValidationError(err)) {
        return toErrorResponse(
          createConfigInvalidError(err.publicError.message, {
            ...(err.publicError.file !== undefined
              ? { file: err.publicError.file }
              : {}),
            ...(err.publicError.path !== undefined
              ? { path: err.publicError.path }
              : {}),
            ...(err.publicError.line !== undefined
              ? { line: err.publicError.line }
              : {}),
            ...(err.publicError.column !== undefined
              ? { column: err.publicError.column }
              : {}),
          }),
        );
      }
      return toErrorResponse(mapErrorToApiResponse(err, allowListForError));
    }
  });

  // 须在 /:server/:container 之前注册，避免 "containers" 被当成 container 名
  app.get("/docker/:server/containers", async (c) => {
    let allowListForError: Awaited<
      ReturnType<typeof load>
    >["allowList"] | undefined;
    try {
      const serverDecoded = decodeParam(c.req.param("server"));
      if (serverDecoded === null) {
        return toErrorResponse(
          createForbiddenError("Docker 目标未登记或无权访问"),
        );
      }

      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }
      const { allowList } = await load(options);
      allowListForError = allowList;

      const authz = authorizeDockerEndpoint(allowList, serverDecoded);
      if (!authz.ok) {
        return toErrorResponse(
          createForbiddenError("Docker 目标未登记或无权访问"),
        );
      }

      let containers;
      try {
        containers = await listContainers(authz.endpoint);
      } catch (err) {
        if (err instanceof DockerClientError) {
          if (err.kind === "timeout") {
            return toErrorResponse(
              createExternalTimeoutError("查询 Docker 超时"),
            );
          }
          return toErrorResponse(
            createExternalFailureError(err.localMessage || "Docker 端点不可达"),
          );
        }
        throw err;
      }

      const body = {
        ok: true as const,
        server: authz.server,
        containers,
      };
      const parsed = ApiSuccessSchemas.dockerContainers.parse(body);
      const secrets = gatherSecrets(allowList);
      if (jsonContainsAnySecret(parsed, secrets)) {
        logError("api/docker", "Docker 列表响应疑似包含敏感值", secrets);
        return toErrorResponse(createInternalError());
      }
      return toJsonResponse(parsed, 200);
    } catch (err) {
      if (isConfigValidationError(err)) {
        return toErrorResponse(
          createConfigInvalidError(err.publicError.message, {
            ...(err.publicError.file !== undefined
              ? { file: err.publicError.file }
              : {}),
            ...(err.publicError.path !== undefined
              ? { path: err.publicError.path }
              : {}),
            ...(err.publicError.line !== undefined
              ? { line: err.publicError.line }
              : {}),
            ...(err.publicError.column !== undefined
              ? { column: err.publicError.column }
              : {}),
          }),
        );
      }
      return toErrorResponse(mapErrorToApiResponse(err, allowListForError));
    }
  });

  app.get("/docker/:server/:container", async (c) => {
    let allowListForError: Awaited<
      ReturnType<typeof load>
    >["allowList"] | undefined;
    try {
      const serverDecoded = decodeParam(c.req.param("server"));
      const containerDecoded = decodeParam(c.req.param("container"));
      if (serverDecoded === null || containerDecoded === null) {
        return toErrorResponse(
          createForbiddenError("Docker 目标未登记或无权访问"),
        );
      }

      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }
      const { allowList } = await load(options);
      allowListForError = allowList;

      const authz = authorizeDockerLookup(
        allowList,
        serverDecoded,
        containerDecoded,
      );
      if (!authz.ok) {
        // 未登记：0 次 Docker 调用
        return toErrorResponse(
          createForbiddenError("Docker 目标未登记或无权访问"),
        );
      }

      // 与批量接口共享短 TTL 缓存；测试若注入 queryStatus 则走原路径
      const status =
        deps.queryStatus !== undefined
          ? await query(authz.endpoint, authz.container)
          : await queryDockerStatusCached(
              authz.server,
              authz.container,
              authz.endpoint,
              {
                ...(statusCache !== undefined ? { cache: statusCache } : {}),
              },
            );
      const parsed = ApiSuccessSchemas.docker.parse(status);
      const secrets = gatherSecrets(allowList);
      if (jsonContainsAnySecret(parsed, secrets)) {
        logError("api/docker", "Docker 响应疑似包含敏感值", secrets);
        return toErrorResponse(createInternalError());
      }
      return toJsonResponse(parsed, 200);
    } catch (err) {
      if (isConfigValidationError(err)) {
        return toErrorResponse(
          createConfigInvalidError(err.publicError.message, {
            ...(err.publicError.file !== undefined
              ? { file: err.publicError.file }
              : {}),
            ...(err.publicError.path !== undefined
              ? { path: err.publicError.path }
              : {}),
            ...(err.publicError.line !== undefined
              ? { line: err.publicError.line }
              : {}),
            ...(err.publicError.column !== undefined
              ? { column: err.publicError.column }
              : {}),
          }),
        );
      }
      return toErrorResponse(mapErrorToApiResponse(err, allowListForError));
    }
  });

  return app;
}
