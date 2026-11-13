/**
 * 前端 API 契约：路由表、成功体类型与浅校验。
 * 服务端是唯一的深度校验方（Go 侧 decode + 业务校验），前端只做结构完整性浅检，
 * 避免把整份 schema 运行时搬进浏览器包。
 */
import type { ErrorEnvelope } from "./common";
import type { NormalizedConfig } from "./config";
import type {
  DockerBatchStatusResponse,
  DockerContainersResponse,
  DockerStatusResponse,
} from "./docker";
import type {
  ConfigWriteSuccessResponse,
  EditableConfig,
  EditableConfigWrite,
} from "./editable";
import type {
  OpenMeteoInfoResponse,
  ResourcesInfoResponse,
} from "./info";
import type { HttpProbeResponse } from "./probe";
import type { ServiceWidgetResult } from "./widget";

export type { ErrorEnvelope, ConfigWriteSuccessResponse, EditableConfig, EditableConfigWrite };

/** 站点图标候选的发现档位，与后端 SiteIconTier 一致 */
export type SiteIconTierContract =
  | "apple-touch-icon"
  | "rel-icon"
  | "static-apple-touch"
  | "static-favicon";

/** POST /api/icons/resolve 返回的单枚候选（含内嵌预览 data URL） */
export type IconCandidate = {
  candidateId: string;
  tier: SiteIconTierContract;
  contentType: string;
  byteLength: number;
  previewDataUrl: string;
  declaredSizes?: string | undefined;
  declaredType?: string | undefined;
};

export type IconResolveSuccessResponse = {
  ok: true;
  sourceUrl: string;
  sessionId: string;
  candidates: IconCandidate[];
};

/** POST /api/icons/import 成功体：与上传一致，返回可写入表单的 /images 路径 */
export type IconImportSuccessResponse = {
  ok: true;
  path: string;
  filename: string;
};

/** POST /api/assets/upload 成功体：返回可写入配置的站点相对路径 */
export type AssetUploadSuccessResponse = {
  ok: true;
  path: string;
  filename: string;
};

/** GET /api/version：当前运行版本 + 可选远端更新检查结果 */
export type VersionSuccessResponse = {
  ok: true;
  version: string;
  updateAvailable: boolean;
  latestVersion?: string | undefined;
  releaseUrl?: string | undefined;
  checkError?: boolean | undefined;
};

export type ConfigSuccessResponse = NormalizedConfig;

export type EditableConfigSuccessResponse = EditableConfig;

export type ProbeSuccessResponse = HttpProbeResponse;

export type DockerSuccessResponse = DockerStatusResponse;

export type DockerContainersSuccessResponse = DockerContainersResponse;

export type DockerBatchSuccessResponse = DockerBatchStatusResponse;

export type WidgetSuccessResponse = ServiceWidgetResult;

export type InfoSuccessResponse = OpenMeteoInfoResponse | ResourcesInfoResponse;

/** 路由键 → 成功体类型。新增端点时只改这一张表。 */
export type ApiSuccessResponses = {
  config: ConfigSuccessResponse;
  editableConfig: EditableConfigSuccessResponse;
  configWrite: ConfigWriteSuccessResponse;
  assetUpload: AssetUploadSuccessResponse;
  iconResolve: IconResolveSuccessResponse;
  iconImport: IconImportSuccessResponse;
  probe: ProbeSuccessResponse;
  docker: DockerSuccessResponse;
  dockerContainers: DockerContainersSuccessResponse;
  dockerBatch: DockerBatchSuccessResponse;
  widgetResult: ServiceWidgetResult;
  info: InfoSuccessResponse;
  version: VersionSuccessResponse;
};

export type ApiSuccessRoute = keyof ApiSuccessResponses;

/** 站点内 API 路径前缀表；带参数的路由由 client 拼接。 */
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
  version: "/api/version",
} as const;

export type ApiRouteKey = keyof typeof ApiRoutes;

/** 顶层字段校验规则：`true` 表示必须存在，字符串表示必须为该 typeof。 */
type FieldRule = true | "string" | "number" | "boolean" | "object";

type ShallowShape = {
  /** 必须严格为 true 的字段 */
  okTrue: boolean;
  fields: Record<string, FieldRule>;
};

/**
 * 每个路由的顶层字段要求。
 * 只校验「有没有、是不是这个类型」，嵌套结构交给服务端与 UI 的容错分支。
 */
const SHALLOW_SHAPES = {
  config: {
    okTrue: false,
    fields: {
      settings: "object",
      services: "object",
      bookmarks: "object",
      infoWidgets: "object",
    },
  },
  editableConfig: {
    okTrue: false,
    fields: {
      settings: "object",
      services: "object",
      bookmarks: "object",
      infoWidgets: "object",
      dockerEndpoints: "object",
    },
  },
  configWrite: { okTrue: true, fields: {} },
  assetUpload: {
    okTrue: true,
    fields: { path: "string", filename: "string" },
  },
  iconResolve: {
    okTrue: true,
    fields: { sourceUrl: "string", sessionId: "string", candidates: "object" },
  },
  iconImport: {
    okTrue: true,
    fields: { path: "string", filename: "string" },
  },
  probe: { okTrue: false, fields: { status: "string" } },
  docker: { okTrue: false, fields: { status: "string" } },
  dockerContainers: {
    okTrue: true,
    fields: { server: "string", containers: "object" },
  },
  dockerBatch: { okTrue: true, fields: { results: "object" } },
  widgetResult: { okTrue: false, fields: { ok: "boolean" } },
  info: { okTrue: false, fields: {} },
  version: {
    okTrue: true,
    fields: { version: "string", updateAvailable: "boolean" },
  },
} as const satisfies Record<ApiSuccessRoute, ShallowShape>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesRule(value: unknown, rule: FieldRule): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (rule === true) {
    return true;
  }
  if (rule === "object") {
    // 数组与对象都算通过，具体结构由使用方按需处理
    return typeof value === "object";
  }
  return typeof value === rule;
}

/**
 * 浅校验成功体。不通过时抛普通 Error，由 api client 包成 `invalid_response`。
 */
export function parseApiSuccess<R extends ApiSuccessRoute>(
  route: R,
  data: unknown,
): ApiSuccessResponses[R] {
  if (!isPlainObject(data)) {
    throw new Error(`响应体不是对象：${route}`);
  }

  const shape: ShallowShape = SHALLOW_SHAPES[route];
  if (shape.okTrue && data["ok"] !== true) {
    throw new Error(`响应体缺少 ok=true：${route}`);
  }

  for (const [field, rule] of Object.entries(shape.fields)) {
    if (!matchesRule(data[field], rule)) {
      throw new Error(`响应体字段缺失或类型不符：${route}.${field}`);
    }
  }

  return data as ApiSuccessResponses[R];
}

/** 宽松解析错误信封；不匹配返回 null，由调用方降级为通用提示。 */
export function parseErrorEnvelope(data: unknown): ErrorEnvelope | null {
  if (!isPlainObject(data) || data["ok"] !== false) {
    return null;
  }
  const error = data["error"];
  if (!isPlainObject(error)) {
    return null;
  }
  const message = error["message"];
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  const result: ErrorEnvelope = { ok: false, error: { message } };
  for (const field of ["file", "path", "code"] as const) {
    const value = error[field];
    if (typeof value === "string" && value.length > 0) {
      result.error[field] = value;
    }
  }
  for (const field of ["line", "column"] as const) {
    const value = error[field];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      result.error[field] = value;
    }
  }
  return result;
}
