export const ApiHttpStatus = {
  OK: 200,
  /** API 路由不存在；必须返回 JSON 错误信封，不得进入 SPA fallback */
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  GATEWAY_TIMEOUT: 504,
} as const;

export type ApiHttpStatusCode =
  (typeof ApiHttpStatus)[keyof typeof ApiHttpStatus];

export const ApiErrorCode = {

  CONFIG_INVALID: "CONFIG_INVALID",

  /** 回滚失败或旧配置验证失败后的故障闸门 */
  CONFIG_FAULTED: "CONFIG_FAULTED",

  /** Docker 连接串含 URI userinfo */
  DOCKER_CONNECTION_SENSITIVE: "DOCKER_CONNECTION_SENSITIVE",

  /** 写回锁等待中 */
  CONFIG_WRITE_IN_PROGRESS: "CONFIG_WRITE_IN_PROGRESS",

  FORBIDDEN: "FORBIDDEN",

  NOT_FOUND: "NOT_FOUND",

  EXTERNAL_FAILURE: "EXTERNAL_FAILURE",

  EXTERNAL_TIMEOUT: "EXTERNAL_TIMEOUT",

  INTERNAL: "INTERNAL",
} as const;

export type ApiErrorCodeValue =
  (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export const API_ERROR_STATUS_BY_CODE = {
  [ApiErrorCode.CONFIG_INVALID]: ApiHttpStatus.UNPROCESSABLE_ENTITY,
  [ApiErrorCode.CONFIG_FAULTED]: ApiHttpStatus.INTERNAL_SERVER_ERROR,
  [ApiErrorCode.DOCKER_CONNECTION_SENSITIVE]: ApiHttpStatus.UNPROCESSABLE_ENTITY,
  [ApiErrorCode.CONFIG_WRITE_IN_PROGRESS]: ApiHttpStatus.CONFLICT,
  [ApiErrorCode.FORBIDDEN]: ApiHttpStatus.FORBIDDEN,
  [ApiErrorCode.NOT_FOUND]: ApiHttpStatus.NOT_FOUND,
  [ApiErrorCode.EXTERNAL_FAILURE]: ApiHttpStatus.BAD_GATEWAY,
  [ApiErrorCode.EXTERNAL_TIMEOUT]: ApiHttpStatus.GATEWAY_TIMEOUT,
  [ApiErrorCode.INTERNAL]: ApiHttpStatus.INTERNAL_SERVER_ERROR,
} as const satisfies Record<ApiErrorCodeValue, ApiHttpStatusCode>;

export function resolveApiErrorStatus(
  code: ApiErrorCodeValue | string | undefined,
): ApiHttpStatusCode {
  if (code !== undefined && code in API_ERROR_STATUS_BY_CODE) {
    return API_ERROR_STATUS_BY_CODE[code as ApiErrorCodeValue];
  }
  return ApiHttpStatus.INTERNAL_SERVER_ERROR;
}

export const API_JSON_CONTENT_TYPE = "application/json; charset=utf-8" as const;
