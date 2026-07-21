import { z } from "zod";

import {
  ErrorEnvelopeSchema,
  PublicErrorSchema,
  type ErrorEnvelope,
  type PublicError,
} from "./common.js";
import { NormalizedConfigSchema } from "./config.js";
import {
  DockerBatchStatusResponseSchema,
  DockerContainersResponseSchema,
  DockerStatusResponseSchema,
} from "./docker.js";
import {
  ConfigWriteSuccessResponseSchema,
  EditableConfigSchema,
  EditableConfigWriteSchema,
  type ConfigWriteSuccessResponse,
  type EditableConfig,
  type EditableConfigWrite,
} from "./editable-config.js";
import {
  API_ERROR_STATUS_BY_CODE,
  API_JSON_CONTENT_TYPE,
  ApiErrorCode,
  ApiHttpStatus,
  resolveApiErrorStatus,
  type ApiErrorCodeValue,
  type ApiHttpStatusCode,
} from "./http-status.js";
import {
  OpenMeteoInfoResponseSchema,
  ResourcesInfoResponseSchema,
} from "./info.js";
import { HttpProbeResponseSchema } from "./probe.js";
import {
  ServiceWidgetOkResponseSchema,
  ServiceWidgetResultSchema,
} from "./widget.js";

export {
  ConfigWriteSuccessResponseSchema,
  EditableConfigSchema,
  EditableConfigWriteSchema,
};

export type {
  ConfigWriteSuccessResponse,
  EditableConfig,
  EditableConfigWrite,
};

/** API 404 必须返回 JSON 错误信封，不得进入 SPA fallback 或返回 HTML */
export const ConfigSuccessResponseSchema = NormalizedConfigSchema;

export type ConfigSuccessResponse = z.infer<typeof ConfigSuccessResponseSchema>;

export const EditableConfigSuccessResponseSchema = EditableConfigSchema;

export type EditableConfigSuccessResponse = EditableConfig;

export const ProbeSuccessResponseSchema = HttpProbeResponseSchema;

export type ProbeSuccessResponse = z.infer<typeof ProbeSuccessResponseSchema>;

export const DockerSuccessResponseSchema = DockerStatusResponseSchema;

export type DockerSuccessResponse = z.infer<typeof DockerSuccessResponseSchema>;

export const DockerContainersSuccessResponseSchema =
  DockerContainersResponseSchema;

export type DockerContainersSuccessResponse = z.infer<
  typeof DockerContainersSuccessResponseSchema
>;

export const DockerBatchSuccessResponseSchema = DockerBatchStatusResponseSchema;

export type DockerBatchSuccessResponse = z.infer<
  typeof DockerBatchSuccessResponseSchema
>;

export const WidgetSuccessResponseSchema = ServiceWidgetOkResponseSchema.extend(
  {
    ok: z.literal(true),
  },
);

export type WidgetSuccessResponse = z.infer<typeof WidgetSuccessResponseSchema>;

export const InfoSuccessResponseSchema = z.union([
  OpenMeteoInfoResponseSchema,
  ResourcesInfoResponseSchema,
]);

export type InfoSuccessResponse = z.infer<typeof InfoSuccessResponseSchema>;

/** POST /api/assets/upload 成功体：返回可写入配置的站点相对路径 */
export const AssetUploadSuccessResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string().min(1),
  filename: z.string().min(1),
});

export type AssetUploadSuccessResponse = z.infer<
  typeof AssetUploadSuccessResponseSchema
>;

export const SiteIconTierSchema = z.enum([
  "apple-touch-icon",
  "rel-icon",
  "static-apple-touch",
  "static-favicon",
]);

export type SiteIconTierContract = z.infer<typeof SiteIconTierSchema>;

/** Resolve 返回的单枚候选（含内嵌预览 data URL） */
export const IconCandidateSchema = z.object({
  candidateId: z.string().min(1),
  tier: SiteIconTierSchema,
  contentType: z.string().min(1),
  byteLength: z.number().int().positive(),
  previewDataUrl: z.string().min(1),
  declaredSizes: z.string().min(1).optional(),
  declaredType: z.string().min(1).optional(),
});

export type IconCandidate = z.infer<typeof IconCandidateSchema>;

/** POST /api/icons/resolve 成功体 */
export const IconResolveSuccessResponseSchema = z.object({
  ok: z.literal(true),
  sourceUrl: z.string().min(1),
  sessionId: z.string().min(1),
  candidates: z.array(IconCandidateSchema).min(1),
});

export type IconResolveSuccessResponse = z.infer<
  typeof IconResolveSuccessResponseSchema
>;

/** POST /api/icons/import 成功体：与上传一致，返回可写入表单的 /images 路径 */
export const IconImportSuccessResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string().min(1),
  filename: z.string().min(1),
});

export type IconImportSuccessResponse = z.infer<
  typeof IconImportSuccessResponseSchema
>;

export const ApiSuccessSchemas = {
  config: ConfigSuccessResponseSchema,
  editableConfig: EditableConfigSuccessResponseSchema,
  configWrite: ConfigWriteSuccessResponseSchema,
  assetUpload: AssetUploadSuccessResponseSchema,
  iconResolve: IconResolveSuccessResponseSchema,
  iconImport: IconImportSuccessResponseSchema,
  probe: ProbeSuccessResponseSchema,
  docker: DockerSuccessResponseSchema,
  dockerContainers: DockerContainersSuccessResponseSchema,
  dockerBatch: DockerBatchSuccessResponseSchema,
  widget: WidgetSuccessResponseSchema,

  widgetResult: ServiceWidgetResultSchema,
  info: InfoSuccessResponseSchema,
  openmeteo: OpenMeteoInfoResponseSchema,
  resources: ResourcesInfoResponseSchema,
} as const;

export type ApiSuccessRoute = keyof typeof ApiSuccessSchemas;

// 错误信封与构造辅助

export { ErrorEnvelopeSchema, PublicErrorSchema };

export type CreatePublicErrorInput = {
  message: string;
  file?: string;
  path?: string;
  line?: number;
  column?: number;
  code?: string;
};

function pickDefinedPublicErrorFields(
  input: CreatePublicErrorInput,
): Record<string, unknown> {
  const result: Record<string, unknown> = { message: input.message };
  if (input.file !== undefined) result["file"] = input.file;
  if (input.path !== undefined) result["path"] = input.path;
  if (input.line !== undefined) result["line"] = input.line;
  if (input.column !== undefined) result["column"] = input.column;
  if (input.code !== undefined) result["code"] = input.code;
  return result;
}

export function createPublicError(input: CreatePublicErrorInput): PublicError {
  return PublicErrorSchema.parse(pickDefinedPublicErrorFields(input));
}

export function createErrorEnvelope(
  error: PublicError | CreatePublicErrorInput,
): ErrorEnvelope {
  const publicError = createPublicError({
    message: error.message,
    ...(error.file !== undefined ? { file: error.file } : {}),
    ...(error.path !== undefined ? { path: error.path } : {}),
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {}),
    ...(error.code !== undefined ? { code: error.code } : {}),
  });
  return ErrorEnvelopeSchema.parse({
    ok: false as const,
    error: publicError,
  });
}

export type ApiErrorResponse = {
  status: ApiHttpStatusCode;
  body: ErrorEnvelope;
  contentType: typeof API_JSON_CONTENT_TYPE;
};

export type CreateApiErrorOptions = CreatePublicErrorInput & {

  status?: ApiHttpStatusCode;
};

export function createApiError(
  code: ApiErrorCodeValue,
  message: string,
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  const statusOverride = extras.status;
  const body = createErrorEnvelope({
    message,
    code,
    ...(extras.file !== undefined ? { file: extras.file } : {}),
    ...(extras.path !== undefined ? { path: extras.path } : {}),
    ...(extras.line !== undefined ? { line: extras.line } : {}),
    ...(extras.column !== undefined ? { column: extras.column } : {}),
  });
  const status = statusOverride ?? API_ERROR_STATUS_BY_CODE[code];

  return {
    status,
    body,
    contentType: API_JSON_CONTENT_TYPE,
  };
}

export function createConfigInvalidError(
  message: string,
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(ApiErrorCode.CONFIG_INVALID, message, extras);
}

export function createConfigFaultedApiError(
  message = "配置处于故障状态，服务已暂停配置读写。请恢复磁盘上的配置五文件后重试",
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(ApiErrorCode.CONFIG_FAULTED, message, extras);
}

export function createDockerConnectionSensitiveApiError(
  message = "Docker 连接串不得包含用户名或密码等内嵌凭据，请改用环境变量或安全的服务端配置方式",
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(
    ApiErrorCode.DOCKER_CONNECTION_SENSITIVE,
    message,
    extras,
  );
}

export function createForbiddenError(
  message: string,
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(ApiErrorCode.FORBIDDEN, message, extras);
}

/** 未知 `/api/*` 路由 → 404 JSON。 必须先于 SPA fallback 处理，且 Content-Type 为 JSON。 */
export function createApiNotFoundError(
  message = "未找到请求的 API 接口",
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(ApiErrorCode.NOT_FOUND, message, extras);
}

export function createExternalFailureError(
  message: string,
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(ApiErrorCode.EXTERNAL_FAILURE, message, extras);
}

export function createExternalTimeoutError(
  message: string,
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(ApiErrorCode.EXTERNAL_TIMEOUT, message, extras);
}

export function createInternalError(
  message = "服务暂时不可用，请稍后重试",
  extras: Omit<CreateApiErrorOptions, "message" | "code"> = {},
): ApiErrorResponse {
  return createApiError(ApiErrorCode.INTERNAL, message, extras);
}

export function isApiPath(pathname: string): boolean {
  if (pathname === "/api") return true;
  return pathname.startsWith("/api/");
}

export function parseApiSuccess<R extends ApiSuccessRoute>(
  route: R,
  data: unknown,
): z.infer<(typeof ApiSuccessSchemas)[R]> {
  return ApiSuccessSchemas[route].parse(data) as z.infer<
    (typeof ApiSuccessSchemas)[R]
  >;
}

export function parseErrorEnvelope(data: unknown): ErrorEnvelope | null {
  const result = ErrorEnvelopeSchema.safeParse(data);
  return result.success ? result.data : null;
}

export const ApiRoutes = {
  config: "/api/config",
  configEditable: "/api/config/editable",
  assetsUpload: "/api/assets/upload",
  iconsResolve: "/api/icons/resolve",
  iconsImport: "/api/icons/import",
  probe: "/api/probe",
  docker: "/api/docker",
  dockerStatus: "/api/docker/status",
  widgets: "/api/widgets",
  info: "/api/info",
} as const;

export type ApiRouteKey = keyof typeof ApiRoutes;

export const ApiSuccessMeta = {
  status: ApiHttpStatus.OK,
  contentType: API_JSON_CONTENT_TYPE,
} as const;
