import { Hono } from "hono";

import {
  configFaultGate,
  getEditableConfig,
  isConfigValidationError,
  loadConfig,
  writeConfig,
  type LoadConfigOptions,
} from "@homepage/config";
import {
  ApiErrorCode,
  ApiSuccessSchemas,
  createConfigFaultedApiError,
  createConfigInvalidError,
  createDockerConnectionSensitiveApiError,
  createInternalError,
  type ApiErrorResponse,
} from "@homepage/domain";

import { toErrorResponse, toJsonResponse } from "../errors.js";
import { gatherSecrets, jsonContainsAnySecret } from "../secrets.js";
import { logError } from "../log.js";

export type ConfigRouteDeps = {
  loadConfigImpl?: typeof loadConfig;
  getEditableConfigImpl?: typeof getEditableConfig;
  writeConfigImpl?: typeof writeConfig;
  getLoadOptions?: () => LoadConfigOptions;
};

function mapConfigError(err: unknown, scope: string): ApiErrorResponse {
  if (isConfigValidationError(err)) {
    const code = err.publicError.code;
    const extras = {
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
    };

    if (code === ApiErrorCode.CONFIG_FAULTED) {
      return createConfigFaultedApiError(err.publicError.message, extras);
    }
    if (code === ApiErrorCode.DOCKER_CONNECTION_SENSITIVE) {
      return createDockerConnectionSensitiveApiError(
        err.publicError.message,
        extras,
      );
    }
    if (code === ApiErrorCode.CONFIG_WRITE_IN_PROGRESS) {
      return {
        ...createConfigInvalidError(err.publicError.message, extras),
        // status overridden via createApiError path — use createApiError directly below
      };
    }
    // 通用：按 publicError.code 映射
    if (
      code === ApiErrorCode.CONFIG_INVALID ||
      code === undefined ||
      code === ""
    ) {
      return createConfigInvalidError(err.publicError.message, extras);
    }
    // 回退到 CONFIG_INVALID 文案，保留 code 通过 createApiError
    return createConfigInvalidError(err.publicError.message, extras);
  }

  logError(scope, "配置处理失败");
  return createInternalError();
}

async function ensureNotFaulted(
  options: LoadConfigOptions,
): Promise<ApiErrorResponse | null> {
  if (!configFaultGate.isFaulted()) {
    return null;
  }
  const recovered = await configFaultGate.tryRecover(options);
  if (recovered) {
    return null;
  }
  return createConfigFaultedApiError(configFaultGate.getReason());
}

export function createConfigRoutes(deps: ConfigRouteDeps = {}): Hono {
  const app = new Hono();
  const load = deps.loadConfigImpl ?? loadConfig;
  const getEditable = deps.getEditableConfigImpl ?? getEditableConfig;
  const write = deps.writeConfigImpl ?? writeConfig;

  app.get("/config", async (c) => {
    try {
      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }

      const { config, allowList } = await load(options);
      const parsed = ApiSuccessSchemas.config.parse(config);
      const secrets = gatherSecrets(allowList);
      if (jsonContainsAnySecret(parsed, secrets)) {
        logError("api/config", "配置响应疑似包含敏感值", secrets);
        return toErrorResponse(
          createInternalError("配置安全校验失败，请检查服务端配置"),
        );
      }
      return toJsonResponse(parsed, 200);
    } catch (err) {
      if (isConfigValidationError(err)) {
        return toErrorResponse(mapConfigError(err, "api/config"));
      }
      logError("api/config", "加载配置失败");
      return toErrorResponse(createInternalError());
    }
  });

  app.get("/config/editable", async (c) => {
    try {
      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }

      const editable = await getEditable(options);
      const parsed = ApiSuccessSchemas.editableConfig.parse(editable);
      // 可编辑响应不应含密钥明文；schema 已约束为 status
      return toJsonResponse(parsed, 200);
    } catch (err) {
      return toErrorResponse(mapConfigError(err, "api/config/editable"));
    }
  });

  app.put("/config", async (c) => {
    try {
      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return toErrorResponse(
          createConfigInvalidError("请求体必须为 JSON 对象"),
        );
      }

      const result = await write(body, options);
      const parsed = ApiSuccessSchemas.configWrite.parse(result);
      return toJsonResponse(parsed, 200);
    } catch (err) {
      return toErrorResponse(mapConfigError(err, "api/config:put"));
    }
  });

  return app;
}

/** 供其他数据路由复用：故障闸门检查 */
export { ensureNotFaulted };
