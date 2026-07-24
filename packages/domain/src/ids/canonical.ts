/** 稳定 ID 规范串构造。 规范串只允许：来源类型、文件内分组/条目索引、规范化类型、必要目标身份。 禁止：随机数、时间戳、进程自增、绝对磁盘目录解析、worker 状态、密钥明文。 */
import {
  normalizeAbsoluteHttpUrl,
  normalizeDiskPathSet,
  normalizeTypeToken,
} from "./normalize.js";

export const CANONICAL_FIELD_SEP = "\u001f" as const;

export const CANONICAL_VERSION = "v1" as const;

export type ServiceCanonicalInput = {

  groupIndex: number;

  serviceIndex: number;
  href?: string | null | undefined;
};

export type ProbeCanonicalInput = {
  groupIndex: number;
  serviceIndex: number;

  probeUrl: string;
};

export type WidgetCanonicalInput = {
  groupIndex: number;
  serviceIndex: number;

  widgetIndex: number;

  widgetType: string;

  targetUrl: string;
};

export type OpenMeteoTargetIdentity = {
  kind: "openmeteo";
  /** 中国天气网城市编码，如 101020100 */
  cityId: string;
};

export type ResourcesTargetIdentity = {
  kind: "resources";

  diskPaths: readonly string[];
};

/** datetime 或其它类型：无额外目标身份（展示格式/标签不参与） */
export type EmptyTargetIdentity = {
  kind: "datetime" | "none";
};

export type InfoTargetIdentity =
  | OpenMeteoTargetIdentity
  | ResourcesTargetIdentity
  | EmptyTargetIdentity;

export type InfoCanonicalInput = {

  entryIndex: number;

  infoType: string;
  targetIdentity: InfoTargetIdentity;
};

function assertNonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} 必须是非负整数`);
  }
  return value;
}

/** 将有序字段拼接为规范串。调用方须保证字段中不含密钥。 */
export function joinCanonicalParts(
  parts: readonly (string | number)[],
): string {
  return parts.map((part) => String(part)).join(CANONICAL_FIELD_SEP);
}

export function buildServiceCanonical(input: ServiceCanonicalInput): string {
  const groupIndex = assertNonNegativeInt("groupIndex", input.groupIndex);
  const serviceIndex = assertNonNegativeInt("serviceIndex", input.serviceIndex);
  const hrefRaw = input.href;
  const normalizedHref =
    hrefRaw === undefined || hrefRaw === null || hrefRaw === ""
      ? ""
      : (normalizeAbsoluteHttpUrl(hrefRaw) ?? "");

  return joinCanonicalParts([
    CANONICAL_VERSION,
    "service",
    "services",
    groupIndex,
    serviceIndex,
    normalizedHref,
  ]);
}

export function buildProbeCanonical(input: ProbeCanonicalInput): string {
  const groupIndex = assertNonNegativeInt("groupIndex", input.groupIndex);
  const serviceIndex = assertNonNegativeInt("serviceIndex", input.serviceIndex);
  const normalizedUrl = normalizeAbsoluteHttpUrl(input.probeUrl) ?? "";

  return joinCanonicalParts([
    CANONICAL_VERSION,
    "probe",
    "services",
    groupIndex,
    serviceIndex,
    normalizedUrl,
  ]);
}

export function buildWidgetCanonical(input: WidgetCanonicalInput): string {
  const groupIndex = assertNonNegativeInt("groupIndex", input.groupIndex);
  const serviceIndex = assertNonNegativeInt("serviceIndex", input.serviceIndex);
  const widgetIndex = assertNonNegativeInt("widgetIndex", input.widgetIndex);
  const widgetType = normalizeTypeToken(input.widgetType);
  const normalizedUrl = normalizeAbsoluteHttpUrl(input.targetUrl) ?? "";

  return joinCanonicalParts([
    CANONICAL_VERSION,
    "widget",
    "services",
    groupIndex,
    serviceIndex,
    widgetIndex,
    widgetType,
    normalizedUrl,
  ]);
}

function encodeInfoTargetIdentity(identity: InfoTargetIdentity): string {
  switch (identity.kind) {
    case "openmeteo": {
      const cityId = identity.cityId.trim();
      return joinCanonicalParts(["openmeteo", cityId]);
    }
    case "resources": {
      const paths = normalizeDiskPathSet(identity.diskPaths);
      return joinCanonicalParts(["resources", ...paths]);
    }
    case "datetime":
      return "datetime";
    case "none":
      return "none";
    default: {
      const _exhaustive: never = identity;
      return _exhaustive;
    }
  }
}

export function buildInfoCanonical(input: InfoCanonicalInput): string {
  const entryIndex = assertNonNegativeInt("entryIndex", input.entryIndex);
  const infoType = normalizeTypeToken(input.infoType);
  const target = encodeInfoTargetIdentity(input.targetIdentity);

  return joinCanonicalParts([
    CANONICAL_VERSION,
    "info",
    "widgets",
    entryIndex,
    infoType,
    target,
  ]);
}
