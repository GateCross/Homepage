import { isConfigValidationError } from "@homepage/config";
import type { AllowList } from "@homepage/config";
import { API_JSON_CONTENT_TYPE } from "@homepage/domain";
import { createApiError } from "@homepage/domain";
import { createConfigInvalidError } from "@homepage/domain";
import { createExternalFailureError } from "@homepage/domain";
import { createExternalTimeoutError } from "@homepage/domain";
import { createForbiddenError } from "@homepage/domain";
import { createInternalError } from "@homepage/domain";
import type { ApiErrorResponse } from "@homepage/domain";
import { DockerClientError } from "./docker/client.js";
import { HttpLocalError } from "./http-utils.js";
import { logError } from "./log.js";
import { gatherSecrets } from "./secrets.js";

export class ForbiddenRequestError extends Error {
  readonly localMessage: string;

  constructor(localMessage: string) {
    super(localMessage);
    this.name = "ForbiddenRequestError";
    this.localMessage = localMessage;
  }
}

export class ResponseValidationError extends Error {
  constructor(message = "响应未通过契约校验") {
    super(message);
    this.name = "ResponseValidationError";
  }
}

export function mapErrorToApiResponse(
  err: unknown,
  allowList?: AllowList,
): ApiErrorResponse {
  const secrets = allowList ? gatherSecrets(allowList) : [];

  if (isConfigValidationError(err)) {
    return createConfigInvalidError(err.publicError.message, {
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
    });
  }

  if (err instanceof ForbiddenRequestError) {
    return createForbiddenError(err.localMessage);
  }

  if (err instanceof HttpLocalError) {
    if (err.kind === "timeout") {
      return createExternalTimeoutError(err.localMessage);
    }
    return createExternalFailureError(err.localMessage);
  }

  if (err instanceof DockerClientError) {
    if (err.kind === "timeout") {
      return createExternalTimeoutError(err.localMessage);
    }
    return createExternalFailureError(err.localMessage);
  }

  if (err instanceof ResponseValidationError) {
    logError("server", err.message, secrets);
    return createInternalError("服务响应校验失败，请稍后重试");
  }

  const message = err instanceof Error ? err.message : String(err);
  logError("server", `未处理异常：${message}`, secrets);
  return createInternalError();
}

export function toErrorResponse(apiError: ApiErrorResponse): Response {
  return new Response(JSON.stringify(apiError.body), {
    status: apiError.status,
    headers: {
      "content-type": API_JSON_CONTENT_TYPE,
      "cache-control": "no-store",
    },
  });
}

export function toJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": API_JSON_CONTENT_TYPE,
      "cache-control": "no-store",
    },
  });
}

export { createApiError };
