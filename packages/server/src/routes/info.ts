import { Hono } from "hono";

import {
  isConfigValidationError,
  loadConfig,
  type LoadConfigOptions,
} from "@homepage/config";
import {
  ApiSuccessSchemas,
  createConfigInvalidError,
  createForbiddenError,
  createInternalError,
} from "@homepage/domain";

import {
  mapErrorToApiResponse,
  toErrorResponse,
  toJsonResponse,
} from "../errors.js";
import {
  fetchOpenMeteoInfo,
  parseOpenMeteoTargetOptions,
} from "../providers/openmeteo.js";
import {
  collectResourcesInfo,
  parseResourcesTargetOptions,
} from "../providers/resources.js";
import { gatherSecrets, jsonContainsAnySecret } from "../secrets.js";
import { logError } from "../log.js";
import { HttpLocalError } from "../http-utils.js";
import { ensureNotFaulted } from "./config.js";

export type InfoRouteDeps = {
  loadConfigImpl?: typeof loadConfig;
  getLoadOptions?: () => LoadConfigOptions;
  fetchOpenMeteo?: typeof fetchOpenMeteoInfo;
  collectResources?: typeof collectResourcesInfo;
};

export function createInfoRoutes(deps: InfoRouteDeps = {}): Hono {
  const app = new Hono();
  const load = deps.loadConfigImpl ?? loadConfig;
  const fetchWeather = deps.fetchOpenMeteo ?? fetchOpenMeteoInfo;
  const collectRes = deps.collectResources ?? collectResourcesInfo;

  app.get("/info/:infoId", async (c) => {
    let allowListForError: Awaited<
      ReturnType<typeof load>
    >["allowList"] | undefined;
    try {
      const rawId = c.req.param("infoId");
      let infoId: string;
      try {
        infoId = decodeURIComponent(rawId).trim();
      } catch {
        return toErrorResponse(
          createForbiddenError("信息组件目标未登记或无权访问"),
        );
      }
      if (infoId.length === 0) {
        return toErrorResponse(
          createForbiddenError("信息组件目标未登记或无权访问"),
        );
      }

      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }
      const { allowList } = await load(options);
      allowListForError = allowList;

      const target = allowList.infoTargets.get(infoId);
      if (target === undefined) {
        return toErrorResponse(
          createForbiddenError("信息组件目标未登记或无权访问"),
        );
      }

      if (target.type === "datetime") {
        // datetime 保持前端本地格式化，不开放任意参数查询
        return toErrorResponse(
          createForbiddenError("日期时间组件由前端本地格式化，不提供数据接口"),
        );
      }

      if (target.type === "openmeteo") {
        const om = parseOpenMeteoTargetOptions(target.options);
        if (om === null) {
          return toErrorResponse(
            createForbiddenError("天气组件配置无效或未登记"),
          );
        }
        const data = await fetchWeather(om);
        const parsed = ApiSuccessSchemas.openmeteo.parse(data);
        const secrets = gatherSecrets(allowList);
        if (jsonContainsAnySecret(parsed, secrets)) {
          logError("api/info", "天气响应疑似包含敏感值", secrets);
          return toErrorResponse(createInternalError());
        }
        return toJsonResponse(parsed, 200);
      }

      if (target.type === "resources") {
        const resOpts = parseResourcesTargetOptions(target.options);
        if (resOpts === null) {
          return toErrorResponse(
            createForbiddenError("资源组件配置无效或未登记"),
          );
        }
        const data = await collectRes(resOpts);
        const parsed = ApiSuccessSchemas.resources.parse(data);
        const secrets = gatherSecrets(allowList);
        if (jsonContainsAnySecret(parsed, secrets)) {
          logError("api/info", "资源响应疑似包含敏感值", secrets);
          return toErrorResponse(createInternalError());
        }
        return toJsonResponse(parsed, 200);
      }

      // 其他类型不在数据 API 白名单
      return toErrorResponse(
        createForbiddenError("信息组件类型不受支持或未登记"),
      );
    } catch (err) {
      if (err instanceof HttpLocalError) {
        return toErrorResponse(mapErrorToApiResponse(err, allowListForError));
      }
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
