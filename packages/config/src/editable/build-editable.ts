import type {
  EditableBookmarkGroup,
  EditableConfig,
  EditableDockerEndpoint,
  EditableHttpProbe,
  EditableInfoWidget,
  EditableServiceGroupView,
  EditableServiceItemView,
  EditableServiceWidgetView,
  EditableSettings,
  NormalizedConfig,
  SecretFieldView,
} from "@homepage/domain";
import { EditableConfigSchema } from "@homepage/domain";

import { assertSafeNormalizedConfig } from "../assert-safe-config.js";
import {
  createEmptyLoadResult,
  createEmptyNormalizedConfig,
} from "../empty.js";
import type {
  LoadConfigOptions,
  LoadConfigResult,
  ParsedConfigSources,
} from "../load-config.js";
import { readAndParseConfigSources } from "../load-config.js";
import { normalizeBookmarks } from "../normalize-bookmarks.js";
import { registerDockerEndpoints } from "../normalize-docker.js";
import {
  expandInfoWidgetEntry,
  extractInfoWidgetEntries,
  normalizeInfoWidgets,
} from "../normalize-info.js";
import { normalizeServices } from "../normalize-services.js";
import { normalizeSettings } from "../normalize-settings.js";
import {
  findFirstSupportedWidget,
  pickEffectiveWidgetDeclarations,
} from "../normalize-widget.js";
import { areAllConfigFilesMissing } from "../read-files.js";
import {
  dockerConnectionHasUserInfo,
  createDockerConnectionSensitiveError,
  secretStatusFromRaw,
} from "./helpers.js";

function secretView(raw: unknown): SecretFieldView {
  return { status: secretStatusFromRaw(raw) };
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

function buildEditableSettings(raw: unknown): EditableSettings {
  if (
    raw === null ||
    raw === undefined ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return {
      title: "",
      useEqualHeights: false,
      layout: [],
    };
  }
  const source = raw as Record<string, unknown>;
  const title =
    typeof source["title"] === "string" ? source["title"] : "";
  const useEqualHeights = source["useEqualHeights"] === true;

  let background: string | undefined;
  const bg = source["background"];
  if (typeof bg === "string") {
    const t = bg.trim();
    if (t.length > 0) background = t;
  } else if (bg !== null && typeof bg === "object" && !Array.isArray(bg)) {
    const image = (bg as Record<string, unknown>)["image"];
    if (typeof image === "string") {
      const t = image.trim();
      if (t.length > 0) background = t;
    }
  }

  let favicon: string | undefined;
  const fav = source["favicon"];
  if (typeof fav === "string") {
    const t = fav.trim();
    if (t.length > 0) favicon = t;
  }

  const layout: EditableSettings["layout"] = [];
  const layoutRaw = source["layout"];
  if (
    layoutRaw !== null &&
    layoutRaw !== undefined &&
    typeof layoutRaw === "object" &&
    !Array.isArray(layoutRaw)
  ) {
    for (const [groupName, groupValue] of Object.entries(
      layoutRaw as Record<string, unknown>,
    )) {
      const name = groupName.trim();
      if (name.length === 0) continue;
      if (
        groupValue === null ||
        typeof groupValue !== "object" ||
        Array.isArray(groupValue)
      ) {
        continue;
      }
      const columns = (groupValue as Record<string, unknown>)["columns"];
      if (
        typeof columns === "number" &&
        Number.isInteger(columns) &&
        columns >= 1
      ) {
        layout.push({ groupName: name, maxColumns: columns });
      }
    }
  }

  const result: EditableSettings = {
    title,
    useEqualHeights,
    layout,
  };
  if (background !== undefined) {
    result.background = background;
  }
  if (favicon !== undefined) {
    result.favicon = favicon;
  }
  return result;
}

function expandGroupArray(
  raw: unknown,
): Array<{ name: string; items: unknown[] }> {
  if (raw === null || raw === undefined) return [];
  const groups: Array<{ name: string; items: unknown[] }> = [];

  const push = (name: string, items: unknown): void => {
    const n = name.trim();
    if (n.length === 0) return;
    groups.push({
      name: n,
      items: Array.isArray(items) ? items : [],
    });
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry)
      ) {
        continue;
      }
      for (const [key, value] of Object.entries(
        entry as Record<string, unknown>,
      )) {
        push(key, value);
      }
    }
    return groups;
  }

  if (typeof raw === "object") {
    for (const [key, value] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      push(key, value);
    }
  }
  return groups;
}

function buildHttpProbe(
  source: Record<string, unknown>,
): EditableHttpProbe | undefined {
  const siteMonitor = source["siteMonitor"];
  if (siteMonitor === undefined || siteMonitor === null || siteMonitor === false) {
    return undefined;
  }

  const probe: EditableHttpProbe = { enabled: true };

  if (typeof siteMonitor === "string") {
    const url = siteMonitor.trim();
    if (url.length > 0) {
      probe.url = url;
    }
  }

  if (typeof source["expectedStatus"] === "string") {
    const es = source["expectedStatus"].trim();
    if (es.length > 0) probe.expectedStatus = es;
  } else if (
    typeof source["expectedStatus"] === "number" &&
    Number.isFinite(source["expectedStatus"])
  ) {
    probe.expectedStatus = String(source["expectedStatus"]);
  }

  const timeout = source["probeTimeout"];
  if (
    typeof timeout === "number" &&
    Number.isInteger(timeout) &&
    timeout >= 1 &&
    timeout <= 60
  ) {
    probe.timeoutSec = timeout;
  }

  return probe;
}

function buildWidgetView(
  source: Record<string, unknown>,
): EditableServiceWidgetView | undefined {
  const list = pickEffectiveWidgetDeclarations(source);
  if (list.length === 0) return undefined;

  // 优先取第一个有 type 的声明（含不支持类型，以便编辑器可见）
  let raw: Record<string, unknown> | null = null;
  let type = "";
  const supported = findFirstSupportedWidget(list);
  if (supported !== null) {
    raw = supported.raw;
    type = supported.type;
  } else {
    for (const entry of list) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry)
      ) {
        const obj = entry as Record<string, unknown>;
        if (typeof obj["type"] === "string" && obj["type"].trim().length > 0) {
          raw = obj;
          type = obj["type"].trim();
          break;
        }
      }
    }
  }
  if (raw === null || type.length === 0) return undefined;

  const widget: EditableServiceWidgetView = { type };

  if (typeof raw["url"] === "string") {
    const u = raw["url"].trim();
    if (u.length > 0) widget.url = u;
  }

  // 密钥字段：仅状态
  if (Object.prototype.hasOwnProperty.call(raw, "username")) {
    widget.username = secretView(raw["username"]);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "password")) {
    widget.password = secretView(raw["password"]);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "key")) {
    widget.key = secretView(raw["key"]);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "apiKey")) {
    widget.apiKey = secretView(raw["apiKey"]);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "token")) {
    widget.token = secretView(raw["token"]);
  }

  if (typeof raw["method"] === "string") {
    const m = raw["method"].trim().toUpperCase();
    if (m === "GET") widget.method = "GET";
  }

  const headersRaw = raw["headers"];
  if (
    headersRaw !== null &&
    headersRaw !== undefined &&
    typeof headersRaw === "object" &&
    !Array.isArray(headersRaw)
  ) {
    const headers: NonNullable<EditableServiceWidgetView["headers"]> = [];
    for (const [name, value] of Object.entries(
      headersRaw as Record<string, unknown>,
    )) {
      const n = name.trim();
      if (n.length === 0) continue;
      headers.push({ name: n, value: secretView(value) });
    }
    if (headers.length > 0) widget.headers = headers;
  }

  if (Array.isArray(raw["mappings"])) {
    const mappings: NonNullable<EditableServiceWidgetView["mappings"]> = [];
    for (const item of raw["mappings"]) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const src = item as Record<string, unknown>;
      const entry: {
        field?: string;
        label?: string;
        format?: string;
        path?: string;
        id?: string;
      } = {};
      if (typeof src["field"] === "string") entry.field = src["field"];
      if (typeof src["label"] === "string") entry.label = src["label"];
      if (typeof src["format"] === "string") entry.format = src["format"];
      if (typeof src["path"] === "string") entry.path = src["path"];
      if (typeof src["id"] === "string") entry.id = src["id"];
      mappings.push(entry);
    }
    if (mappings.length > 0) widget.mappings = mappings;
  }

  return widget;
}

function buildServiceItem(raw: unknown): EditableServiceItemView | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const name =
    typeof source["name"] === "string" ? source["name"] : "";
  // 名称空时仍投影，前端校验会拦截
  const item: EditableServiceItemView = { name };

  if (typeof source["href"] === "string") {
    const href = source["href"].trim();
    if (href.length > 0) item.href = href;
  }

  if (typeof source["target"] === "string") {
    const t = source["target"].trim();
    if (
      t === "_blank" ||
      t === "_self" ||
      t === "_parent" ||
      t === "_top"
    ) {
      item.target = t;
    }
  }

  const icon = optionalString(source["icon"]);
  if (icon !== undefined) item.icon = icon;

  if (typeof source["description"] === "string") {
    item.description = source["description"];
  }

  if (source["hidden"] === true) {
    item.hidden = true;
  }

  const probe = buildHttpProbe(source);
  if (probe !== undefined) item.httpProbe = probe;

  const server = optionalString(source["server"]);
  const container = optionalString(source["container"]);
  if (server !== undefined && container !== undefined) {
    item.docker = { server, container };
  }

  const widget = buildWidgetView(source);
  if (widget !== undefined) item.widget = widget;

  return item;
}

function buildServices(raw: unknown): EditableServiceGroupView[] {
  return expandGroupArray(raw).map(({ name, items }) => ({
    name,
    items: items
      .map((it) => buildServiceItem(it))
      .filter((it): it is EditableServiceItemView => it !== null),
  }));
}

function buildBookmarks(raw: unknown): EditableBookmarkGroup[] {
  return expandGroupArray(raw).map(({ name, items }) => ({
    name,
    items: items
      .map((it) => {
        if (it === null || typeof it !== "object" || Array.isArray(it)) {
          return null;
        }
        const source = it as Record<string, unknown>;
        const itemName =
          typeof source["name"] === "string" ? source["name"] : "";
        const href =
          typeof source["href"] === "string" ? source["href"] : "";
        const bookmark: EditableBookmarkGroup["items"][number] = {
          name: itemName,
          href,
        };
        if (typeof source["target"] === "string") {
          const t = source["target"].trim();
          if (
            t === "_blank" ||
            t === "_self" ||
            t === "_parent" ||
            t === "_top"
          ) {
            bookmark.target = t;
          }
        }
        const icon = optionalString(source["icon"]);
        if (icon !== undefined) bookmark.icon = icon;
        const abbr = optionalString(source["abbr"]);
        if (abbr !== undefined) bookmark.abbr = abbr;
        if (typeof source["description"] === "string") {
          bookmark.description = source["description"];
        }
        return bookmark;
      })
      .filter((it): it is EditableBookmarkGroup["items"][number] => it !== null),
  }));
}

function buildInfoWidgets(raw: unknown): EditableInfoWidget[] {
  const entries = extractInfoWidgetEntries(raw);
  const result: EditableInfoWidget[] = [];

  for (const entry of entries) {
    const expanded = expandInfoWidgetEntry(entry);
    if (expanded === null) continue;
    const typeRaw = expanded["type"];
    if (typeof typeRaw !== "string") continue;
    const type = typeRaw.trim().toLowerCase();

    if (type === "datetime") {
      const w: EditableInfoWidget = { type: "datetime" };
      if (typeof expanded["timezone"] === "string") {
        w.timezone = expanded["timezone"];
      }
      if (typeof expanded["label"] === "string") {
        w.label = expanded["label"];
      }
      if (
        expanded["format"] !== null &&
        typeof expanded["format"] === "object" &&
        !Array.isArray(expanded["format"])
      ) {
        const f = expanded["format"] as Record<string, unknown>;
        const format: NonNullable<
          Extract<EditableInfoWidget, { type: "datetime" }>["format"]
        > = {};
        if (typeof f["timeStyle"] === "string") format.timeStyle = f["timeStyle"];
        if (typeof f["dateStyle"] === "string") format.dateStyle = f["dateStyle"];
        if (typeof f["hour12"] === "boolean") format.hour12 = f["hour12"];
        if (Object.keys(format).length > 0) w.format = format;
      }
      result.push(w);
      continue;
    }

    if (type === "openmeteo") {
      const cityIdRaw = expanded["cityId"];
      let cityId = "";
      if (typeof cityIdRaw === "string") {
        cityId = cityIdRaw.trim().replace(/^weathercn:/i, "");
      } else if (typeof cityIdRaw === "number" && Number.isFinite(cityIdRaw)) {
        cityId = String(Math.trunc(cityIdRaw));
      }
      const locationRaw = expanded["location"];
      const location =
        typeof locationRaw === "string" && locationRaw.trim().length > 0
          ? locationRaw.trim()
          : typeof expanded["label"] === "string" &&
              expanded["label"].trim().length > 0
            ? expanded["label"].trim()
            : "";
      if (cityId.length === 0 || location.length === 0) {
        continue;
      }
      const w: EditableInfoWidget = {
        type: "openmeteo",
        cityId,
        location,
      };
      if (typeof expanded["label"] === "string") {
        w.label = expanded["label"];
      }
      result.push(w);
      continue;
    }

    if (type === "resources") {
      const w: EditableInfoWidget = { type: "resources" };
      if (typeof expanded["cpu"] === "boolean") w.cpu = expanded["cpu"];
      if (typeof expanded["memory"] === "boolean") w.memory = expanded["memory"];
      if (typeof expanded["label"] === "string") w.label = expanded["label"];
      // disk：保留路径 + 可选别名（对象 / path|alias 字符串）
      const toDiskEntry = (
        d: unknown,
      ): string | { path: string; label?: string } | null => {
        if (typeof d === "string" && d.trim().length > 0) return d;
        if (d !== null && typeof d === "object" && !Array.isArray(d)) {
          const obj = d as Record<string, unknown>;
          if (typeof obj["path"] === "string" && obj["path"].trim().length > 0) {
            const entry: { path: string; label?: string } = {
              path: obj["path"],
            };
            if (typeof obj["label"] === "string" && obj["label"].trim()) {
              entry.label = obj["label"].trim();
            } else if (typeof obj["name"] === "string" && obj["name"].trim()) {
              entry.label = obj["name"].trim();
            } else if (
              typeof obj["alias"] === "string" &&
              obj["alias"].trim()
            ) {
              entry.label = obj["alias"].trim();
            }
            return entry;
          }
        }
        return null;
      };

      if (typeof expanded["disk"] === "string") {
        w.disk = expanded["disk"];
      } else if (Array.isArray(expanded["disk"])) {
        const list = expanded["disk"]
          .map(toDiskEntry)
          .filter((d): d is NonNullable<typeof d> => d !== null);
        if (list.length > 0) {
          w.disk = list;
        }
      } else if (typeof expanded["diskPath"] === "string") {
        w.disk = expanded["diskPath"];
      } else if (Array.isArray(expanded["diskPaths"])) {
        const list = expanded["diskPaths"]
          .map(toDiskEntry)
          .filter((d): d is NonNullable<typeof d> => d !== null);
        if (list.length > 0) {
          w.disk = list;
        }
      } else if (Array.isArray(expanded["disks"])) {
        const list = expanded["disks"]
          .map(toDiskEntry)
          .filter((d): d is NonNullable<typeof d> => d !== null);
        if (list.length > 0) {
          w.disk = list;
        }
      }
      result.push(w);
    }
    // 未知类型：不进入可编辑主字段（保留在原始树）
  }

  return result;
}

function buildDockerEndpoints(raw: unknown): EditableDockerEndpoint[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) return [];

  const endpoints: EditableDockerEndpoint[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (name.length === 0) continue;
    if (typeof value !== "string") {
      // 非字符串连接串：无法安全投影，跳过（保存时原始键仍保留）
      continue;
    }
    if (dockerConnectionHasUserInfo(value)) {
      throw createDockerConnectionSensitiveError(`dockerEndpoints.${name}`);
    }
    endpoints.push({ name, connection: value });
  }
  return endpoints;
}

/**
 * 将原始解析树投影为可编辑配置。
 * 密钥状态只取自原始树；loadedConfig 用于确认完整加载已成功（调用方保证）。
 */
export function buildEditableConfig(
  sources: ParsedConfigSources,
  _loadedConfig: NormalizedConfig | LoadConfigResult,
): EditableConfig {
  void _loadedConfig;

  const editable: EditableConfig = {
    settings: buildEditableSettings(sources.settings),
    services: buildServices(sources.services),
    bookmarks: buildBookmarks(sources.bookmarks),
    infoWidgets: buildInfoWidgets(sources.widgets),
    dockerEndpoints: buildDockerEndpoints(sources.docker),
  };

  return EditableConfigSchema.parse(editable);
}

/** 同一请求：原始树 + 完整规范化（单次读盘），二者均成功后构建可编辑结果。 */
export async function getEditableConfig(
  options: LoadConfigOptions = {},
): Promise<EditableConfig> {
  const { files, sources } = await readAndParseConfigSources(options);

  if (areAllConfigFilesMissing(files)) {
    return buildEditableConfig(sources, createEmptyLoadResult());
  }

  const base = createEmptyNormalizedConfig();
  const { allowList } = createEmptyLoadResult();
  registerDockerEndpoints(sources.docker, allowList);
  const env = options.env ?? process.env;
  const draft: NormalizedConfig = {
    ...base,
    settings: normalizeSettings(sources.settings),
    services: normalizeServices(sources.services, { allowList, env }),
    bookmarks: normalizeBookmarks(sources.bookmarks),
    infoWidgets: normalizeInfoWidgets(sources.widgets, { allowList }),
  };
  const config = assertSafeNormalizedConfig(draft, allowList);
  return buildEditableConfig(sources, { config, allowList });
}
