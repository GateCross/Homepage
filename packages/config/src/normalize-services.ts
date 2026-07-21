/** dgets → 稳定 widgetId，密钥与目标仅登记 AllowList.widgetTargets */
import {
  buildProbeId,
  buildServiceId,
  normalizeAbsoluteHttpUrl,
  normalizeExpectedStatus,
  sortServicesStable,
  type NormalizedService,
  type ServiceGroup,
  type ServiceGroupItem,
  type StatusRange,
} from "@homepage/domain";

import type { AllowList, HttpProbeTarget } from "./allowlist.js";
import { tryRegisterServiceDocker } from "./normalize-docker.js";
import {
  normalizeServiceWidget,
  type NormalizeWidgetEnv,
} from "./normalize-widget.js";

const SAFE_TARGETS = new Set(["_blank", "_self", "_parent", "_top"]);

const DEFAULT_TARGET = "_blank";

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const PROBE_TIMEOUT_SEC_MIN = 1;

const PROBE_TIMEOUT_SEC_MAX = 60;

function normalizeServiceName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeServiceHref(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = normalizeAbsoluteHttpUrl(raw);
  return normalized ?? undefined;
}

function normalizeServiceTarget(raw: unknown): string {
  if (typeof raw !== "string") {
    return DEFAULT_TARGET;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return DEFAULT_TARGET;
  }
  return SAFE_TARGETS.has(trimmed) ? trimmed : DEFAULT_TARGET;
}

function normalizeServiceIcon(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeServiceDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeServiceWeight(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return raw;
}

/** 判断配置中是否「存在」ping 字段（含 false / 空串等显式值）。 存在则标记暂不支持，不参与可达性。 */
function hasPingField(source: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(source, "ping") &&
    source["ping"] !== undefined
  );
}

export function resolveProbeTargetUrl(
  siteMonitor: unknown,
  normalizedHref: string | undefined,
): string | null {
  if (typeof siteMonitor === "string") {
    return normalizeAbsoluteHttpUrl(siteMonitor);
  }
  if (siteMonitor === true) {
    return normalizedHref ?? null;
  }
  return null;
}

export function normalizeProbeTimeoutMs(raw: unknown): number {
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= PROBE_TIMEOUT_SEC_MIN &&
    raw <= PROBE_TIMEOUT_SEC_MAX
  ) {
    return raw * 1000;
  }
  return DEFAULT_PROBE_TIMEOUT_MS;
}

/** 在当次 AllowList 登记 HTTP 探测目标，并返回浏览器安全视图上的 `httpProbe`。 探测 URL、expectedStatus、timeout 仅进入 AllowList，不进入返回的安全字段。 */
function registerHttpProbe(options: {
  allowList: AllowList;
  groupIndex: number;
  serviceIndex: number;
  probeUrl: string;
  expectedStatusRaw: unknown;
  probeTimeoutRaw: unknown;
}): NonNullable<NormalizedService["httpProbe"]> {
  const {
    allowList,
    groupIndex,
    serviceIndex,
    probeUrl,
    expectedStatusRaw,
    probeTimeoutRaw,
  } = options;

  const probeId = buildProbeId({
    groupIndex,
    serviceIndex,
    probeUrl,
  });

  const expectedRanges: StatusRange[] =
    normalizeExpectedStatus(expectedStatusRaw);
  const timeoutMs = normalizeProbeTimeoutMs(probeTimeoutRaw);

  const target: HttpProbeTarget = {
    url: probeUrl,
    timeoutMs,
  };
  if (expectedRanges.length > 0) {
    target.expectedStatus = expectedRanges;
  }

  allowList.httpProbeTargets.set(probeId, target);

  return {
    enabled: true,
    probeId,
  };
}

export type NormalizeServiceContext = {
  allowList?: AllowList;
  /** 密钥整值插值环境；缺省使用 process.env */
  env?: NormalizeWidgetEnv;
};

export function normalizeServiceItem(
  raw: unknown,
  groupIndex: number,
  serviceIndex: number,
  contextOrAllowList?: AllowList | NormalizeServiceContext,
): ServiceGroupItem {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "error",
      message: "服务条目格式无效，须为包含 name 等字段的对象",
    };
  }

  const source = raw as Record<string, unknown>;
  const context = resolveServiceContext(contextOrAllowList);
  const allowList = context.allowList;
  const env = context.env ?? process.env;

  // showStats：接受但不产生任何统计输出（不触发 stats 能力）
  void source["showStats"];

  const name = normalizeServiceName(source["name"]);
  if (name === null) {
    return {
      kind: "error",
      message: "服务名称无效或为空",
    };
  }

  const hrefRaw = source["href"];
  const hrefForId = typeof hrefRaw === "string" ? hrefRaw : undefined;
  const id = buildServiceId({
    groupIndex,
    serviceIndex,
    href: hrefForId,
  });

  const href = normalizeServiceHref(source["href"]);
  const target = normalizeServiceTarget(source["target"]);
  const icon = normalizeServiceIcon(source["icon"]);
  const description = normalizeServiceDescription(source["description"]);
  const weight = normalizeServiceWeight(source["weight"]);

  const service: NormalizedService = {
    id,
    name,
    target,
  };

  if (href !== undefined) {
    service.href = href;
  }
  if (icon !== undefined) {
    service.icon = icon;
  }
  if (description !== undefined) {
    service.description = description;
  }
  if (weight !== undefined) {
    service.weight = weight;
  }
  if (hasPingField(source)) {
    service.pingUnsupported = true;
  }

  const probeUrl = resolveProbeTargetUrl(source["siteMonitor"], href);
  if (probeUrl !== null && allowList !== undefined) {
    service.httpProbe = registerHttpProbe({
      allowList,
      groupIndex,
      serviceIndex,
      probeUrl,
      expectedStatusRaw: source["expectedStatus"],
      probeTimeoutRaw: source["probeTimeout"],
    });
  }

  const dockerRef = tryRegisterServiceDocker(source, allowList);
  if (dockerRef !== undefined) {
    service.docker = dockerRef;
  }

  const widgetRef = normalizeServiceWidget(source, {
    groupIndex,
    serviceIndex,
    env,
    ...(allowList !== undefined ? { allowList } : {}),
  });
  if (widgetRef !== undefined) {
    service.widget = widgetRef;
  }

  return service;
}

function resolveServiceContext(
  contextOrAllowList?: AllowList | NormalizeServiceContext,
): NormalizeServiceContext {
  if (contextOrAllowList === undefined) {
    return {};
  }
  // AllowList 以 httpProbeTargets Map 为特征；上下文对象则无此字段
  if ("httpProbeTargets" in contextOrAllowList) {
    return { allowList: contextOrAllowList as AllowList };
  }
  return contextOrAllowList;
}

function normalizeGroupItems(
  rawItems: unknown,
  groupIndex: number,
  context?: NormalizeServiceContext,
): ServiceGroupItem[] {
  if (!Array.isArray(rawItems)) {
    // 分组值非数组：视为无条目，不使整文件失败
    return [];
  }

  const items: ServiceGroupItem[] = [];
  for (let serviceIndex = 0; serviceIndex < rawItems.length; serviceIndex += 1) {
    const raw = rawItems[serviceIndex];
    // hidden：跳过公开视图与 allowlist 登记；编辑器走 editable 路径
    if (
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>)["hidden"] === true
    ) {
      continue;
    }
    items.push(
      normalizeServiceItem(raw, groupIndex, serviceIndex, context),
    );
  }

  // sortServicesStable 的 Weightable 约束对 error 分支不直接适用；
  // 用 weight 提取包装，保证错误项与无 weight 项相对顺序稳定。
  type SortRow = { weight?: number; item: ServiceGroupItem };
  const rows: SortRow[] = items.map((item) => {
    if ("kind" in item && item.kind === "error") {
      return { item };
    }
    const service = item as NormalizedService;
    const weight = service.weight;
    return typeof weight === "number" && Number.isFinite(weight)
      ? { weight, item: service }
      : { item: service };
  });

  return sortServicesStable(rows).map((row) => row.item);
}

function pushGroup(
  groups: ServiceGroup[],
  groupName: string,
  rawItems: unknown,
  groupIndex: number,
  context?: NormalizeServiceContext,
): void {
  const name = groupName.trim();
  if (name.length === 0) {
    return;
  }
  groups.push({
    name,
    items: normalizeGroupItems(rawItems, groupIndex, context),
  });
}

function expandArrayGroupEntry(
  entry: unknown,
): { name: string; items: unknown }[] {
  if (entry === null || entry === undefined || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  const result: { name: string; items: unknown }[] = [];
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    result.push({ name: key, items: value });
  }
  return result;
}

export function normalizeServices(
  raw: unknown,
  contextOrAllowList?: AllowList | NormalizeServiceContext,
): ServiceGroup[] {
  if (raw === null || raw === undefined) {
    return [];
  }

  const context = resolveServiceContext(contextOrAllowList);
  const groups: ServiceGroup[] = [];
  let groupIndex = 0;

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const expanded = expandArrayGroupEntry(entry);
      if (expanded.length === 0) {
        // 非法数组元素：跳过，不拖垮整文件
        continue;
      }
      for (const { name, items } of expanded) {
        const indexForId = groupIndex;
        groupIndex += 1;
        pushGroup(groups, name, items, indexForId, context);
      }
    }
    return groups;
  }

  if (typeof raw === "object") {
    // 顶层映射形态：按键序作为分组声明顺序
    for (const [name, items] of Object.entries(raw as Record<string, unknown>)) {
      const indexForId = groupIndex;
      groupIndex += 1;
      pushGroup(groups, name, items, indexForId, context);
    }
    return groups;
  }

  // 标量等：顶层结构校验本应已拦截；此处安全回退为空
  return [];
}
