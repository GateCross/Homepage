/** 份夹具」确定性分配四类稳定 ID，并构建当次 AllowList 风格 Map。 用途： - 在 `loadConfig()` 尚未落地前，于领域边界模拟其 ID 赋值与鉴权登记规则； - 供 的双次 */
import {
  buildInfoId,
  buildProbeId,
  buildServiceId,
  buildWidgetId,
} from "./builders.js";
import {
  buildInfoCanonical,
  buildProbeCanonical,
  buildServiceCanonical,
  buildWidgetCanonical,
  type InfoTargetIdentity,
} from "./canonical.js";
import { normalizeAbsoluteHttpUrl, normalizeTypeToken } from "./normalize.js";

const SUPPORTED_SERVICE_WIDGET_TYPES = new Set([
  "qbittorrent",
  "transmission",
  "emby",
  "customapi",
  "immich",
  "caddy",
]);

const SUPPORTED_INFO_WIDGET_TYPES = new Set([
  "datetime",
  "openmeteo",
  "resources",
]);

/** 夹具中的服务组件声明（可含密钥等不参与 ID 的字段） */
export type FixtureServiceWidget = {
  type: string;

  url?: string | null | undefined;
  username?: string | undefined;
  password?: string | undefined;
  key?: string | undefined;
  apiKey?: string | undefined;
  token?: string | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  mappings?: unknown;
  /** 其它展示/选项字段，一律不参与 ID */
  [extra: string]: unknown;
};

export type FixtureServiceItem = {
  name?: string | undefined;
  href?: string | null | undefined;
  description?: string | undefined;
  icon?: string | undefined;
  weight?: number | undefined;
  target?: string | undefined;

  siteMonitor?: string | boolean | undefined;
  expectedStatus?: unknown;
  probeTimeout?: number | undefined;
  widget?: FixtureServiceWidget | undefined;
  widgets?: readonly FixtureServiceWidget[] | undefined;

  [extra: string]: unknown;
};

export type FixtureInfoWidget = {
  type: string;
  /** 展示用标签/格式等，不参与 ID */
  label?: string | undefined;
  format?: string | undefined;
  cityId?: string | undefined;
  location?: string | undefined;
  timezone?: string | undefined;
  diskPaths?: readonly string[] | undefined;
  [extra: string]: unknown;
};

export type IdAssignmentFixture = {

  serviceGroups: readonly {
    name?: string | undefined;
    items: readonly FixtureServiceItem[];
  }[];

  infoWidgets?: readonly FixtureInfoWidget[] | undefined;
};

export type FourIdSets = {
  serviceIds: readonly string[];
  probeIds: readonly string[];
  widgetIds: readonly string[];
  infoIds: readonly string[];
};

export type ProbeAllowEntry = {
  probeId: string;
  url: string;
  groupIndex: number;
  serviceIndex: number;
};

export type WidgetAllowEntry = {
  widgetId: string;
  type: string;
  url: string;
  groupIndex: number;
  serviceIndex: number;
  widgetIndex: number;
  /** 仅服务端持有；不得出现在公开 ID / 规范串 */
  secrets: Readonly<Record<string, string>>;
};

export type InfoAllowEntry = {
  infoId: string;
  type: string;
  entryIndex: number;
  targetIdentity: InfoTargetIdentity;
};

/** 当次 AllowList 风格结构（Map 键为公开稳定 ID）。 模拟数据 API「每次重建 AllowList 后按 ID 鉴权」的登记面。 */
export type SimulatedAllowList = {
  httpProbeTargets: Map<string, ProbeAllowEntry>;
  widgetTargets: Map<string, WidgetAllowEntry>;
  infoTargets: Map<string, InfoAllowEntry>;
};

export type IdAssignmentResult = {
  ids: FourIdSets;
  allowList: SimulatedAllowList;
  /** 全部规范串，供密钥泄漏扫描 */
  canonicals: readonly string[];

  serviceIdByPosition: ReadonlyMap<string, string>;
};

function positionKey(groupIndex: number, serviceIndex: number): string {
  return `${groupIndex}:${serviceIndex}`;
}

function pickEffectiveWidgets(
  item: FixtureServiceItem,
): readonly FixtureServiceWidget[] {
  if (item.widgets !== undefined && item.widgets.length > 0) {
    return item.widgets;
  }
  if (item.widget !== undefined) {
    return [item.widget];
  }
  return [];
}

function selectFirstSupportedWidget(item: FixtureServiceItem): {
  widgetIndex: number;
  widget: FixtureServiceWidget;
} | null {
  const list = pickEffectiveWidgets(item);
  for (let i = 0; i < list.length; i += 1) {
    const widget = list[i];
    if (widget === undefined) {
      continue;
    }
    const type = normalizeTypeToken(String(widget.type ?? ""));
    if (SUPPORTED_SERVICE_WIDGET_TYPES.has(type)) {
      return { widgetIndex: i, widget };
    }
  }
  return null;
}

function resolveProbeUrl(item: FixtureServiceItem): string | null {
  const monitor = item.siteMonitor;
  if (typeof monitor === "string") {
    return normalizeAbsoluteHttpUrl(monitor);
  }
  if (monitor === true) {
    if (item.href === undefined || item.href === null) {
      return null;
    }
    return normalizeAbsoluteHttpUrl(String(item.href));
  }
  return null;
}

function collectWidgetSecrets(
  widget: FixtureServiceWidget,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  const assign = (key: string, value: unknown): void => {
    if (typeof value === "string" && value.length > 0) {
      secrets[key] = value;
    }
  };
  assign("username", widget.username);
  assign("password", widget.password);
  assign("key", widget.key);
  assign("apiKey", widget.apiKey);
  assign("token", widget.token);
  if (widget.headers !== undefined) {
    for (const [headerName, headerValue] of Object.entries(widget.headers)) {
      assign(`header:${headerName}`, headerValue);
    }
  }
  return secrets;
}

function buildInfoTargetIdentity(info: FixtureInfoWidget): InfoTargetIdentity {
  const type = normalizeTypeToken(String(info.type ?? ""));
  if (type === "openmeteo") {
    return {
      kind: "openmeteo",
      cityId: typeof info.cityId === "string" ? info.cityId : "",
    };
  }
  if (type === "resources") {
    return {
      kind: "resources",
      diskPaths: info.diskPaths ?? [],
    };
  }
  if (type === "datetime") {
    return { kind: "datetime" };
  }
  return { kind: "none" };
}

export function assignStableIdsFromFixture(
  fixture: IdAssignmentFixture,
): IdAssignmentResult {
  const serviceIds: string[] = [];
  const probeIds: string[] = [];
  const widgetIds: string[] = [];
  const infoIds: string[] = [];
  const canonicals: string[] = [];
  const serviceIdByPosition = new Map<string, string>();

  const httpProbeTargets = new Map<string, ProbeAllowEntry>();
  const widgetTargets = new Map<string, WidgetAllowEntry>();
  const infoTargets = new Map<string, InfoAllowEntry>();

  const groups = fixture.serviceGroups;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (group === undefined) {
      continue;
    }
    const items = group.items;
    for (let serviceIndex = 0; serviceIndex < items.length; serviceIndex += 1) {
      const item = items[serviceIndex];
      if (item === undefined) {
        continue;
      }

      const serviceInput = {
        groupIndex,
        serviceIndex,
        href: item.href,
      };
      const serviceId = buildServiceId(serviceInput);
      serviceIds.push(serviceId);
      serviceIdByPosition.set(positionKey(groupIndex, serviceIndex), serviceId);
      canonicals.push(buildServiceCanonical(serviceInput));

      const probeUrl = resolveProbeUrl(item);
      if (probeUrl !== null) {
        const probeInput = {
          groupIndex,
          serviceIndex,
          probeUrl,
        };
        const probeId = buildProbeId(probeInput);
        probeIds.push(probeId);
        canonicals.push(buildProbeCanonical(probeInput));
        httpProbeTargets.set(probeId, {
          probeId,
          url: probeUrl,
          groupIndex,
          serviceIndex,
        });
      }

      const selected = selectFirstSupportedWidget(item);
      if (selected !== null) {
        const widgetType = normalizeTypeToken(String(selected.widget.type));
        const targetUrl =
          typeof selected.widget.url === "string" ? selected.widget.url : "";
        const widgetInput = {
          groupIndex,
          serviceIndex,
          widgetIndex: selected.widgetIndex,
          widgetType,
          targetUrl,
        };
        const widgetId = buildWidgetId(widgetInput);
        widgetIds.push(widgetId);
        canonicals.push(buildWidgetCanonical(widgetInput));
        widgetTargets.set(widgetId, {
          widgetId,
          type: widgetType,
          url: normalizeAbsoluteHttpUrl(targetUrl) ?? "",
          groupIndex,
          serviceIndex,
          widgetIndex: selected.widgetIndex,
          secrets: collectWidgetSecrets(selected.widget),
        });
      }
    }
  }

  const infoList = fixture.infoWidgets ?? [];
  for (let entryIndex = 0; entryIndex < infoList.length; entryIndex += 1) {
    const info = infoList[entryIndex];
    if (info === undefined) {
      continue;
    }
    const infoType = normalizeTypeToken(String(info.type ?? ""));
    // 未支持类型仍可生成稳定 infoId（前端标暂不支持），但不登记数据目标
    const targetIdentity = buildInfoTargetIdentity(info);
    const infoInput = {
      entryIndex,
      infoType,
      targetIdentity,
    };
    const infoId = buildInfoId(infoInput);
    infoIds.push(infoId);
    canonicals.push(buildInfoCanonical(infoInput));
    if (SUPPORTED_INFO_WIDGET_TYPES.has(infoType)) {
      infoTargets.set(infoId, {
        infoId,
        type: infoType,
        entryIndex,
        targetIdentity,
      });
    }
  }

  return {
    ids: {
      serviceIds,
      probeIds,
      widgetIds,
      infoIds,
    },
    allowList: {
      httpProbeTargets,
      widgetTargets,
      infoTargets,
    },
    canonicals,
    serviceIdByPosition,
  };
}

export function serializeFourIdSets(ids: FourIdSets): FourIdSets {
  return {
    serviceIds: [...ids.serviceIds],
    probeIds: [...ids.probeIds],
    widgetIds: [...ids.widgetIds],
    infoIds: [...ids.infoIds],
  };
}

export function findMissedAllowListIdsFromResults(
  previous: IdAssignmentResult,
  next: IdAssignmentResult,
): {
  missedProbeIds: string[];
  missedWidgetIds: string[];
  missedInfoIds: string[];
} {
  const missedProbeIds = previous.ids.probeIds.filter(
    (id) => !next.allowList.httpProbeTargets.has(id),
  );
  const missedWidgetIds = previous.ids.widgetIds.filter(
    (id) => !next.allowList.widgetTargets.has(id),
  );
  // 仅检查旧 AllowList 中实际登记过的 infoId（受支持类型）
  const previousRegisteredInfoIds = [...previous.allowList.infoTargets.keys()];
  const missedInfoIds = previousRegisteredInfoIds.filter(
    (id) => !next.allowList.infoTargets.has(id),
  );
  return {
    missedProbeIds: [...missedProbeIds],
    missedWidgetIds: [...missedWidgetIds],
    missedInfoIds: [...missedInfoIds],
  };
}

/** 收集结果中所有可能进入公开 ID、规范串或非密钥登记字段的字符串，供密钥扫描。 刻意不包含 `secrets` 字典值本身。 */
export function collectPublicIdSurfaces(result: IdAssignmentResult): string[] {
  const surfaces: string[] = [
    ...result.ids.serviceIds,
    ...result.ids.probeIds,
    ...result.ids.widgetIds,
    ...result.ids.infoIds,
    ...result.canonicals,
  ];
  for (const entry of result.allowList.httpProbeTargets.values()) {
    surfaces.push(entry.probeId, entry.url);
  }
  for (const entry of result.allowList.widgetTargets.values()) {
    surfaces.push(entry.widgetId, entry.type, entry.url);
  }
  for (const entry of result.allowList.infoTargets.values()) {
    surfaces.push(
      entry.infoId,
      entry.type,
      JSON.stringify(entry.targetIdentity),
    );
  }
  return surfaces;
}
