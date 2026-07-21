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
  ForbiddenRequestError,
  mapErrorToApiResponse,
  toErrorResponse,
  toJsonResponse,
} from "../errors.js";
import { runHttpProbe } from "../probe.js";
import { gatherSecrets, jsonContainsAnySecret } from "../secrets.js";
import { logError } from "../log.js";
import { ensureNotFaulted } from "./config.js";

export type ProbeRouteDeps = {
  loadConfigImpl?: typeof loadConfig;
  getLoadOptions?: () => LoadConfigOptions;
  runProbe?: typeof runHttpProbe;
};

export function createProbeRoutes(deps: ProbeRouteDeps = {}): Hono {
  const app = new Hono();
  const load = deps.loadConfigImpl ?? loadConfig;
  const probe = deps.runProbe ?? runHttpProbe;

  app.get("/probe/:probeId", async (c) => {
    let allowListForError: Awaited<
      ReturnType<typeof load>
    >["allowList"] | undefined;
    try {
      const probeIdParam = c.req.param("probeId");
      let probeId: string;
      try {
        probeId = decodeURIComponent(probeIdParam).trim();
      } catch {
        return toErrorResponse(createForbiddenError("探测目标未登记或无权访问"));
      }
      if (probeId.length === 0) {
        return toErrorResponse(createForbiddenError("探测目标未登记或无权访问"));
      }

      const options = deps.getLoadOptions?.() ?? {};
      const faulted = await ensureNotFaulted(options);
      if (faulted !== null) {
        return toErrorResponse(faulted);
      }
      const { allowList } = await load(options);
      allowListForError = allowList;

      const target = allowList.httpProbeTargets.get(probeId);
      if (target === undefined) {
        // 未登记：0 次网络
        return toErrorResponse(createForbiddenError("探测目标未登记或无权访问"));
      }

      const result = await probe({
        url: target.url,
        timeoutMs: target.timeoutMs,
        ...(target.expectedStatus !== undefined
          ? { expectedStatus: target.expectedStatus }
          : {}),
      });

      const parsed = ApiSuccessSchemas.probe.parse(result);
      const secrets = gatherSecrets(allowList);
      if (jsonContainsAnySecret(parsed, secrets)) {
        logError("api/probe", "探测响应疑似包含敏感值", secrets);
        return toErrorResponse(createInternalError());
      }
      return toJsonResponse(parsed, 200);
    } catch (err) {
      if (err instanceof ForbiddenRequestError) {
        return toErrorResponse(createForbiddenError(err.localMessage));
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
