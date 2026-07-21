import { Hono } from "hono";

import { runServiceWidget } from "@homepage/adapters";
import {
  isConfigValidationError,
  loadConfig,
  type LoadConfigOptions,
} from "@homepage/config";
import {
  ApiSuccessSchemas,
  ServiceWidgetResultSchema,
  createConfigInvalidError,
  createForbiddenError,
  createInternalError,
} from "@homepage/domain";

import {
  mapErrorToApiResponse,
  toErrorResponse,
  toJsonResponse,
} from "../errors.js";
import { gatherSecrets, jsonContainsAnySecret } from "../secrets.js";
import { logError } from "../log.js";
import { ensureNotFaulted } from "./config.js";

export type WidgetsRouteDeps = {
  loadConfigImpl?: typeof loadConfig;
  getLoadOptions?: () => LoadConfigOptions;
  runWidget?: typeof runServiceWidget;
};

export function createWidgetsRoutes(deps: WidgetsRouteDeps = {}): Hono {
  const app = new Hono();
  const load = deps.loadConfigImpl ?? loadConfig;
  const runWidget = deps.runWidget ?? runServiceWidget;

  app.get("/widgets/:widgetId", async (c) => {
    let allowListForError: Awaited<
      ReturnType<typeof load>
    >["allowList"] | undefined;
    try {
      const rawId = c.req.param("widgetId");
      let widgetId: string;
      try {
        widgetId = decodeURIComponent(rawId).trim();
      } catch {
        return toErrorResponse(
          createForbiddenError("服务组件目标未登记或无权访问"),
        );
      }
      if (widgetId.length === 0) {
        return toErrorResponse(
          createForbiddenError("服务组件目标未登记或无权访问"),
        );
      }

      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }
      const { allowList } = await load(options);
      allowListForError = allowList;

      const target = allowList.widgetTargets.get(widgetId);
      if (target === undefined) {
        return toErrorResponse(
          createForbiddenError("服务组件目标未登记或无权访问"),
        );
      }

      const result = await runWidget({
        type: target.type,
        url: target.url,
        secrets: target.secrets,
        options: target.options,
      });

      // 适配器业务失败仍以 200 + ok:false 返回（与契约一致）
      const parsedResult = ServiceWidgetResultSchema.parse(result);
      const secrets = gatherSecrets(allowList);

      if (parsedResult.ok) {
        const successBody = ApiSuccessSchemas.widget.parse(parsedResult);
        if (jsonContainsAnySecret(successBody, secrets)) {
          logError("api/widgets", "组件响应疑似包含敏感值", secrets);
          return toErrorResponse(createInternalError());
        }
        return toJsonResponse(successBody, 200);
      }

      if (jsonContainsAnySecret(parsedResult, secrets)) {
        logError("api/widgets", "组件错误响应疑似包含敏感值", secrets);
        return toJsonResponse(
          { ok: false as const, error: "服务组件请求失败" },
          200,
        );
      }
      return toJsonResponse(parsedResult, 200);
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
