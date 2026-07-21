/** 时区、resources 磁盘路径仅进入当次 AllowList.infoTargets - 前端 InfoWidgetConfig.options 仅含非敏感展示配置 - datetime：规范化 */
import {
  buildInfoId,
  normalizeDiskPathIdentity,
  normalizeDiskPathSet,
  normalizeTypeToken,
  type InfoTargetIdentity,
  type InfoWidgetConfig,
  type InfoWidgetType,
} from "@homepage/domain";

import type { AllowList, InfoTarget } from "./allowlist.js";

export const SUPPORTED_INFO_WIDGET_TYPES = [
  "datetime",
  "openmeteo",
  "resources",
] as const satisfies readonly InfoWidgetType[];

const SUPPORTED_SET = new Set<string>(SUPPORTED_INFO_WIDGET_TYPES);

export const DEFAULT_INFO_TIMEZONE = "UTC" as const;

export const DATETIME_STYLE_VALUES = ["short", "medium", "long"] as const;

export type DatetimeStyle = (typeof DATETIME_STYLE_VALUES)[number];

const DATETIME_STYLE_SET = new Set<string>(DATETIME_STYLE_VALUES);

export type NormalizeInfoContext = {
  allowList?: AllowList;
};

export type DatetimeInfoOptions = {
  timezone: string;
  format: {
    timeStyle?: DatetimeStyle;
    dateStyle?: DatetimeStyle;
    hour12?: boolean;
  };
  label?: string;
};

export type OpenMeteoInfoTargetOptions = {
  cityId: string;
  location: string;
};

export type ResourceDiskEntry = {
  path: string;
  /** 展示别名；缺省时前端用路径短形式 */
  label?: string;
};

export type ResourcesInfoTargetOptions = {
  /** @deprecated 兼容旧调用方；优先使用 disks */
  diskPaths: readonly string[];
  disks: readonly ResourceDiskEntry[];
  cpu: boolean;
  memory: boolean;
};

export function extractInfoWidgetEntries(source: unknown): unknown[] {
  if (source === null || source === undefined) {
    return [];
  }
  if (Array.isArray(source)) {
    return source;
  }
  if (typeof source === "object") {
    const entries: unknown[] = [];
    for (const [key, value] of Object.entries(
      source as Record<string, unknown>,
    )) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if (typeof obj["type"] === "string") {
          entries.push(obj);
        } else {
          // 映射键作为类型名的简写：`datetime: { timezone: ... }`
          entries.push({ type: key, ...obj });
        }
      } else if (value === null || value === undefined) {
        entries.push({ type: key });
      }
    }
    return entries;
  }
  return [];
}

export function expandInfoWidgetEntry(
  raw: unknown,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return null;
  }
  if (Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj["type"] === "string" && obj["type"].trim().length > 0) {
    return obj;
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const typeKey = keys[0];
    if (typeKey === undefined || typeKey.trim().length === 0) {
      return null;
    }
    const inner = obj[typeKey];
    if (inner === null || inner === undefined) {
      return { type: typeKey };
    }
    if (typeof inner === "object" && !Array.isArray(inner)) {
      return { type: typeKey, ...(inner as Record<string, unknown>) };
    }
    // 标量值无字段语义，仅保留类型
    return { type: typeKey };
  }

  return null;
}

/** 校验 IANA 时区标识是否可被运行时 Intl 接受。 非法输入不得抛出。 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  const tz = timeZone.trim();
  if (tz.length === 0) {
    return false;
  }
  try {
    // 构造失败或无效时区会抛 RangeError
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function normalizeIanaTimeZone(
  raw: unknown,
  fallback: string = DEFAULT_INFO_TIMEZONE,
): string {
  try {
    if (typeof raw !== "string") {
      return isValidIanaTimeZone(fallback) ? fallback.trim() : DEFAULT_INFO_TIMEZONE;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return isValidIanaTimeZone(fallback) ? fallback.trim() : DEFAULT_INFO_TIMEZONE;
    }
    if (isValidIanaTimeZone(trimmed)) {
      return trimmed;
    }
    return isValidIanaTimeZone(fallback) ? fallback.trim() : DEFAULT_INFO_TIMEZONE;
  } catch {
    return DEFAULT_INFO_TIMEZONE;
  }
}

export function normalizeDatetimeFormat(raw: unknown): DatetimeInfoOptions["format"] {
  const format: DatetimeInfoOptions["format"] = {};
  try {
    if (raw === null || raw === undefined) {
      return format;
    }
    // Homepage 旧式字符串 format（如 "LLLL"）第一阶段不支持 → 安全忽略
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return format;
    }
    const src = raw as Record<string, unknown>;

    const timeStyle = normalizeDatetimeStyle(src["timeStyle"]);
    if (timeStyle !== undefined) {
      format.timeStyle = timeStyle;
    }
    const dateStyle = normalizeDatetimeStyle(src["dateStyle"]);
    if (dateStyle !== undefined) {
      format.dateStyle = dateStyle;
    }
    if (typeof src["hour12"] === "boolean") {
      format.hour12 = src["hour12"];
    }
  } catch {
    return {};
  }
  return format;
}

function normalizeDatetimeStyle(raw: unknown): DatetimeStyle | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const token = raw.trim().toLowerCase();
  if (DATETIME_STYLE_SET.has(token)) {
    return token as DatetimeStyle;
  }
  return undefined;
}

function normalizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 解析「路径」或「路径|别名」；别名分隔符为 | 或 ：/： */
function parsePathWithOptionalLabel(raw: string): ResourceDiskEntry | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // path|alias 或 path：alias / path:alias（冒号后非盘符）
  const pipeIdx = trimmed.indexOf("|");
  if (pipeIdx > 0) {
    const pathPart = trimmed.slice(0, pipeIdx).trim();
    const labelPart = trimmed.slice(pipeIdx + 1).trim();
    const path = normalizeDiskPathIdentity(pathPart);
    if (path.length === 0) return null;
    return labelPart.length > 0 ? { path, label: labelPart } : { path };
  }

  // Windows 盘符 C:\ 不误拆；Unix 路径用全角/半角冒号作别名
  const colonMatch = trimmed.match(/^(.+?)[：:](.+)$/);
  if (colonMatch) {
    const left = colonMatch[1]!.trim();
    const right = colonMatch[2]!.trim();
    // 排除 Windows 盘符 "C:"
    if (!(left.length === 1 && /[A-Za-z]/.test(left))) {
      const path = normalizeDiskPathIdentity(left);
      if (path.length === 0) return null;
      return right.length > 0 ? { path, label: right } : { path };
    }
  }

  const path = normalizeDiskPathIdentity(trimmed);
  if (path.length === 0) return null;
  return { path };
}

function pushDiskEntry(
  out: ResourceDiskEntry[],
  seen: Map<string, number>,
  entry: ResourceDiskEntry,
): void {
  const existing = seen.get(entry.path);
  if (existing !== undefined) {
    // 后写的别名覆盖；路径身份保持一条
    const prev = out[existing];
    if (prev && entry.label) {
      out[existing] = { path: entry.path, label: entry.label };
    }
    return;
  }
  seen.set(entry.path, out.length);
  out.push(entry);
}

/**
 * 收集 resources 磁盘条目（路径 + 可选别名）。
 * 兼容 string / string[] / { path, label? }[]，以及逗号分隔的「路径|别名」。
 */
export function collectResourceDiskEntries(
  raw: Record<string, unknown>,
): ResourceDiskEntry[] {
  const entries: ResourceDiskEntry[] = [];
  const seen = new Map<string, number>();

  const pushOne = (value: unknown): void => {
    if (typeof value === "string") {
      // 支持单字段内逗号分隔多个「路径|别名」
      const chunks = value.split(/[,，]/);
      const parts = chunks.length > 1 ? chunks : [value];
      for (const chunk of parts) {
        const parsed = parsePathWithOptionalLabel(chunk);
        if (parsed) pushDiskEntry(entries, seen, parsed);
      }
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        pushOne(item);
      }
      return;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const pathRaw =
        typeof obj["path"] === "string"
          ? obj["path"]
          : typeof obj["disk"] === "string"
            ? obj["disk"]
            : typeof obj["mount"] === "string"
              ? obj["mount"]
              : undefined;
      if (pathRaw === undefined) return;
      const path = normalizeDiskPathIdentity(pathRaw);
      if (path.length === 0) return;
      const labelRaw =
        typeof obj["label"] === "string"
          ? obj["label"]
          : typeof obj["name"] === "string"
            ? obj["name"]
            : typeof obj["alias"] === "string"
              ? obj["alias"]
              : undefined;
      const label =
        labelRaw !== undefined && labelRaw.trim().length > 0
          ? labelRaw.trim()
          : undefined;
      pushDiskEntry(
        entries,
        seen,
        label !== undefined ? { path, label } : { path },
      );
    }
  };

  if (Object.prototype.hasOwnProperty.call(raw, "diskPaths")) {
    pushOne(raw["diskPaths"]);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "diskPath")) {
    pushOne(raw["diskPath"]);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "disks")) {
    pushOne(raw["disks"]);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "disk")) {
    pushOne(raw["disk"]);
  }

  // 与 infoId 身份一致：按路径排序（别名不参与身份）
  const sortedPaths = normalizeDiskPathSet(entries.map((e) => e.path));
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return sortedPaths.map((p) => byPath.get(p)!).filter(Boolean);
}

/** @deprecated 使用 collectResourceDiskEntries */
export function collectResourceDiskPaths(
  raw: Record<string, unknown>,
): string[] {
  return collectResourceDiskEntries(raw).map((e) => e.path);
}

function normalizeBoolFlag(raw: unknown, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null) {
    return defaultValue;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") {
      return true;
    }
    if (t === "false" || t === "0" || t === "no") {
      return false;
    }
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw === 1) return true;
    if (raw === 0) return false;
  }
  return defaultValue;
}

function buildTargetIdentity(
  type: string,
  raw: Record<string, unknown>,
): InfoTargetIdentity {
  if (type === "openmeteo") {
    const cityId =
      typeof raw["cityId"] === "string"
        ? raw["cityId"]
        : typeof raw["cityId"] === "number" && Number.isFinite(raw["cityId"])
          ? String(Math.trunc(raw["cityId"]))
          : "";
    return {
      kind: "openmeteo",
      cityId,
    };
  }
  if (type === "resources") {
    return {
      kind: "resources",
      diskPaths: collectResourceDiskEntries(raw).map((e) => e.path),
    };
  }
  if (type === "datetime") {
    return { kind: "datetime" };
  }
  return { kind: "none" };
}

function normalizeDatetimeWidget(
  raw: Record<string, unknown>,
  infoId: string,
  allowList: AllowList | undefined,
): InfoWidgetConfig {
  const timezone = normalizeIanaTimeZone(raw["timezone"]);
  // 身份用的原始时区串不参与展示回退；展示用已校验时区
  const format = normalizeDatetimeFormat(raw["format"]);
  const label = normalizeLabel(raw["label"]);

  const options: DatetimeInfoOptions = {
    timezone,
    format,
  };
  if (label !== undefined) {
    options.label = label;
  }

  if (allowList !== undefined) {
    // datetime 无服务端出站目标；仍登记最小元数据，便于当次配置自检与统一 infoId 面
    const target: InfoTarget = {
      type: "datetime",
      options: {
        timezone,
        format,
      },
    };
    allowList.infoTargets.set(infoId, target);
  }

  return {
    infoId,
    type: "datetime",
    options: options as unknown as Record<string, unknown>,
  };
}

function normalizeCityId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const s = String(Math.trunc(raw));
    return /^\d{6,12}$/.test(s) ? s : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // 允许 "weathercn:101020100" 或纯数字
    const stripped = trimmed.replace(/^weathercn:/i, "");
    if (/^\d{6,12}$/.test(stripped)) {
      return stripped;
    }
  }
  return null;
}

function normalizeOpenMeteoWidget(
  raw: Record<string, unknown>,
  infoId: string,
  allowList: AllowList | undefined,
): InfoWidgetConfig {
  const cityId = normalizeCityId(raw["cityId"]);
  const location = normalizeLabel(raw["location"]) ?? normalizeLabel(raw["label"]);
  const label = normalizeLabel(raw["label"]);

  if (allowList !== undefined && cityId !== null && location !== undefined) {
    const targetOptions: OpenMeteoInfoTargetOptions = {
      cityId,
      location,
    };
    const target: InfoTarget = {
      type: "openmeteo",
      options: targetOptions,
    };
    allowList.infoTargets.set(infoId, target);
  }

  const options: Record<string, unknown> = {};
  if (location !== undefined) {
    options["location"] = location;
  }
  if (label !== undefined) {
    options["label"] = label;
  }

  return {
    infoId,
    type: "openmeteo",
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

function normalizeResourcesWidget(
  raw: Record<string, unknown>,
  infoId: string,
  allowList: AllowList | undefined,
): InfoWidgetConfig {
  const disks = collectResourceDiskEntries(raw);
  const diskPaths = disks.map((e) => e.path);
  const cpu = normalizeBoolFlag(raw["cpu"], true);
  const memory = normalizeBoolFlag(raw["memory"], true);
  const label = normalizeLabel(raw["label"]);

  if (allowList !== undefined) {
    const targetOptions: ResourcesInfoTargetOptions = {
      diskPaths,
      disks,
      cpu,
      memory,
    };
    const target: InfoTarget = {
      type: "resources",
      options: targetOptions,
    };
    allowList.infoTargets.set(infoId, target);
  }

  const options: Record<string, unknown> = {
    cpu,
    memory,
  };
  if (label !== undefined) {
    options["label"] = label;
  }

  return {
    infoId,
    type: "resources",
    options,
  };
}

export function normalizeInfoWidgetEntry(
  raw: Record<string, unknown>,
  entryIndex: number,
  context: NormalizeInfoContext = {},
): InfoWidgetConfig | undefined {
  const typeRaw = raw["type"];
  if (typeof typeRaw !== "string" || typeRaw.trim().length === 0) {
    return undefined;
  }

  const type = normalizeTypeToken(typeRaw);
  const targetIdentity = buildTargetIdentity(type, raw);

  const infoId = buildInfoId({
    entryIndex,
    infoType: type,
    targetIdentity,
  });

  if (!SUPPORTED_SET.has(type)) {
    // 暂不支持：生成稳定 infoId，不登记数据目标
    return {
      infoId,
      type,
      unsupported: true,
    };
  }

  try {
    if (type === "datetime") {
      return normalizeDatetimeWidget(raw, infoId, context.allowList);
    }
    if (type === "openmeteo") {
      return normalizeOpenMeteoWidget(raw, infoId, context.allowList);
    }
    // resources
    return normalizeResourcesWidget(raw, infoId, context.allowList);
  } catch {
    // 防御：任何未预期异常都不得冒泡；降级为带 infoId 的安全视图
    if (SUPPORTED_SET.has(type)) {
      // 受支持类型异常时仍给出可渲染占位（不登记目标，避免坏配置出站）
      return {
        infoId,
        type,
        options: {},
      };
    }
    return {
      infoId,
      type,
      unsupported: true,
    };
  }
}

export function normalizeInfoWidgets(
  source: unknown,
  context: NormalizeInfoContext = {},
): InfoWidgetConfig[] {
  const entries = extractInfoWidgetEntries(source);
  const result: InfoWidgetConfig[] = [];

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    try {
      const expanded = expandInfoWidgetEntry(entries[entryIndex]);
      if (expanded === null) {
        continue;
      }
      const normalized = normalizeInfoWidgetEntry(expanded, entryIndex, context);
      if (normalized !== undefined) {
        result.push(normalized);
      }
    } catch {
      // 单条异常跳过，不拖垮整份 widgets.yaml
      continue;
    }
  }

  return result;
}
