import type {
  EditableBookmarkGroup,
  EditableConfigWrite,
  EditableDockerEndpoint,
  EditableHttpProbe,
  EditableInfoWidget,
  EditableServiceGroupWrite,
  EditableServiceItemWrite,
  EditableServiceWidgetWrite,
  EditableSettings,
  SecretFieldWrite,
} from "@homepage/domain";

import type { ParsedConfigSources } from "../load-config.js";
import {
  createFieldValidationError,
  isNonEmptySecretString,
} from "./helpers.js";

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function applySecretWrite(
  target: Record<string, unknown>,
  key: string,
  write: SecretFieldWrite | undefined,
  diskRaw: unknown,
): void {
  if (write === undefined) {
    // 未提交该字段：保留磁盘原值（若存在）
    if (isNonEmptySecretString(diskRaw) || typeof diskRaw === "string") {
      target[key] = diskRaw;
    } else if (Object.prototype.hasOwnProperty.call(target, key)) {
      // 保持原样
    }
    return;
  }
  switch (write.mode) {
    case "keep":
      if (typeof diskRaw === "string") {
        target[key] = diskRaw;
      } else if (diskRaw === undefined || diskRaw === null) {
        delete target[key];
      } else {
        // 非字符串磁盘值：无法安全 keep
        throw createFieldValidationError(
          `密钥字段 ${key} 的磁盘值类型无法安全保留`,
          { path: key },
        );
      }
      break;
    case "set":
      if (write.value.length === 0) {
        delete target[key];
      } else {
        target[key] = write.value;
      }
      break;
    case "clear":
      delete target[key];
      break;
    default: {
      const _e: never = write;
      void _e;
    }
  }
}

function mergeSettings(
  disk: unknown,
  editable: EditableSettings,
): Record<string, unknown> {
  const base = asRecord(disk) ? deepClone(asRecord(disk)!) : {};

  base["title"] = editable.title;
  base["useEqualHeights"] = editable.useEqualHeights;

  if (editable.background !== undefined && editable.background.trim().length > 0) {
    // 写出稳定形态：字符串；若原为 { image } 且仅 image，保持 { image } 形态
    const prev = base["background"];
    if (
      prev !== null &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      Object.prototype.hasOwnProperty.call(prev as object, "image")
    ) {
      const prevObj = deepClone(prev as Record<string, unknown>);
      prevObj["image"] = editable.background;
      base["background"] = prevObj;
    } else {
      base["background"] = editable.background;
    }
  } else {
    // 清空 background：删除键
    delete base["background"];
  }

  if (editable.favicon !== undefined && editable.favicon.trim().length > 0) {
    base["favicon"] = editable.favicon.trim();
  } else {
    delete base["favicon"];
  }

  // layout：以原始 layout 对象为基底，按 groupName 更新 columns；编辑器列表中的分组写入
  const prevLayout = asRecord(base["layout"]);
  const layoutOut: Record<string, unknown> = prevLayout
    ? deepClone(prevLayout)
    : {};

  // 先清除将由编辑器完全重写的 columns 集合：以编辑器列表为准重建已知分组
  // 未知分组键保留
  const editorNames = new Set(
    editable.layout.map((e) => e.groupName.trim()).filter((n) => n.length > 0),
  );

  // 删除不在编辑器列表中的「仅 columns 结构」分组？规格：只更新支持字段。
  // layout 分组集合以编辑器为准（用户可删分组布局），但保留未知子键。
  for (const key of Object.keys(layoutOut)) {
    if (!editorNames.has(key)) {
      // 编辑器未列出：若仅含 columns 则删除；若有未知子键则只删 columns 保留其余
      const entry = asRecord(layoutOut[key]);
      if (entry === null) {
        delete layoutOut[key];
        continue;
      }
      const keys = Object.keys(entry);
      if (keys.length === 0 || (keys.length === 1 && keys[0] === "columns")) {
        delete layoutOut[key];
      } else {
        delete entry["columns"];
        layoutOut[key] = entry;
      }
    }
  }

  for (const entry of editable.layout) {
    const name = entry.groupName.trim();
    if (name.length === 0) continue;
    const prev = asRecord(layoutOut[name]);
    const next = prev ? deepClone(prev) : {};
    next["columns"] = entry.maxColumns;
    layoutOut[name] = next;
  }

  if (Object.keys(layoutOut).length > 0) {
    base["layout"] = layoutOut;
  } else {
    delete base["layout"];
  }

  return base;
}

function findDiskServiceItem(
  diskServices: unknown,
  groupName: string,
  itemName: string,
  itemIndex: number,
): Record<string, unknown> | null {
  const groups = expandDiskGroups(diskServices);
  const group = groups.find((g) => g.name === groupName);
  if (!group) return null;
  // 优先按索引 + name 对应
  const byIndex = group.items[itemIndex];
  if (byIndex && asRecord(byIndex)?.["name"] === itemName) {
    return asRecord(byIndex);
  }
  // 回退：同名唯一匹配
  const matches = group.items
    .map((it) => asRecord(it))
    .filter((it): it is Record<string, unknown> => it !== null)
    .filter((it) => it["name"] === itemName);
  if (matches.length === 1) return matches[0] ?? null;
  return null;
}

function expandDiskGroups(
  raw: unknown,
): Array<{ name: string; items: unknown[] }> {
  if (raw === null || raw === undefined) return [];
  const groups: Array<{ name: string; items: unknown[] }> = [];
  const push = (name: string, items: unknown): void => {
    const n = name.trim();
    if (!n) return;
    groups.push({ name: n, items: Array.isArray(items) ? items : [] });
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const rec = asRecord(entry);
      if (!rec) continue;
      for (const [k, v] of Object.entries(rec)) push(k, v);
    }
    return groups;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      push(k, v);
    }
  }
  return groups;
}

function mergeHttpProbe(
  target: Record<string, unknown>,
  probe: EditableHttpProbe | undefined,
  diskItem: Record<string, unknown> | null,
): void {
  if (probe === undefined || !probe.enabled) {
    delete target["siteMonitor"];
    // expectedStatus / probeTimeout 若仅服务于探测，删除支持字段；未知保留
    delete target["expectedStatus"];
    delete target["probeTimeout"];
    return;
  }

  if (probe.url !== undefined && probe.url.trim().length > 0) {
    target["siteMonitor"] = probe.url.trim();
  } else if (diskItem && diskItem["siteMonitor"] === true) {
    target["siteMonitor"] = true;
  } else {
    // 启用但无 URL：与加载器对齐，写 true 回退 href
    target["siteMonitor"] = true;
  }

  if (probe.expectedStatus !== undefined && probe.expectedStatus.trim()) {
    target["expectedStatus"] = probe.expectedStatus.trim();
  } else if (diskItem && typeof diskItem["expectedStatus"] !== "undefined") {
    // 编辑器未带 expectedStatus：若磁盘有则保留（未改）
    // 但 editable 若省略表示清除？规格：支持字段以编辑器为准
    // httpProbe.expectedStatus optional — 省略时保留磁盘
    if (probe.expectedStatus === undefined) {
      // keep disk
    }
  } else {
    delete target["expectedStatus"];
  }

  // 更清晰：若 editable 提供了字段则写；否则保留磁盘
  if (probe.expectedStatus !== undefined) {
    if (probe.expectedStatus.trim()) {
      target["expectedStatus"] = probe.expectedStatus.trim();
    } else {
      delete target["expectedStatus"];
    }
  } else if (diskItem && "expectedStatus" in diskItem) {
    target["expectedStatus"] = diskItem["expectedStatus"];
  }

  if (probe.timeoutSec !== undefined) {
    target["probeTimeout"] = probe.timeoutSec;
  } else if (diskItem && "probeTimeout" in diskItem) {
    target["probeTimeout"] = diskItem["probeTimeout"];
  }
}

function mergeWidget(
  target: Record<string, unknown>,
  widget: EditableServiceWidgetWrite | undefined,
  diskItem: Record<string, unknown> | null,
): void {
  if (widget === undefined) {
    // 编辑器无 widget：删除支持的 widget/widgets 键？若磁盘有则保留原始（用户未编辑组件）
    // 规格：支持字段以编辑器为准。EditableServiceItem.widget optional —
    // 若写回省略 widget，表示清除组件。
    delete target["widget"];
    delete target["widgets"];
    return;
  }

  const diskWidget = extractDiskWidget(diskItem);
  const out: Record<string, unknown> = diskWidget
    ? deepClone(diskWidget)
    : {};

  out["type"] = widget.type;

  if (widget.url !== undefined && widget.url.trim()) {
    out["url"] = widget.url.trim();
  } else {
    delete out["url"];
  }

  applySecretWrite(out, "username", widget.username, diskWidget?.["username"]);
  applySecretWrite(out, "password", widget.password, diskWidget?.["password"]);
  applySecretWrite(out, "key", widget.key, diskWidget?.["key"]);
  applySecretWrite(out, "apiKey", widget.apiKey, diskWidget?.["apiKey"]);
  applySecretWrite(out, "token", widget.token, diskWidget?.["token"]);

  if (widget.method !== undefined) {
    out["method"] = widget.method;
  }

  if (widget.headers !== undefined) {
    const diskHeaders = asRecord(diskWidget?.["headers"]) ?? {};
    const headersOut: Record<string, unknown> = {};
    for (const h of widget.headers) {
      const name = h.name.trim();
      if (!name) continue;
      const diskVal = diskHeaders[name];
      // 使用临时对象应用 secret write
      const tmp: Record<string, unknown> = {};
      if (typeof diskVal === "string") tmp[name] = diskVal;
      applySecretWrite(tmp, name, h.value, diskVal);
      if (Object.prototype.hasOwnProperty.call(tmp, name)) {
        headersOut[name] = tmp[name];
      }
    }
    if (Object.keys(headersOut).length > 0) {
      out["headers"] = headersOut;
    } else {
      delete out["headers"];
    }
  }

  if (widget.mappings !== undefined) {
    out["mappings"] = widget.mappings.map((m) => {
      const entry: Record<string, unknown> = {};
      if (m.field !== undefined) entry["field"] = m.field;
      if (m.label !== undefined) entry["label"] = m.label;
      if (m.format !== undefined) entry["format"] = m.format;
      if (m.path !== undefined) entry["path"] = m.path;
      if (m.id !== undefined) entry["id"] = m.id;
      return entry;
    });
  }

  // Emby 展示选项：以编辑器为准写回；未出现则删除磁盘旧值
  if (widget.enableBlocks !== undefined) {
    out["enableBlocks"] = widget.enableBlocks;
  } else {
    delete out["enableBlocks"];
  }
  if (widget.enableNowPlaying !== undefined) {
    out["enableNowPlaying"] = widget.enableNowPlaying;
  } else {
    delete out["enableNowPlaying"];
  }
  if (widget.enableUser !== undefined) {
    out["enableUser"] = widget.enableUser;
  } else {
    delete out["enableUser"];
  }
  if (widget.showEpisodeNumber !== undefined) {
    out["showEpisodeNumber"] = widget.showEpisodeNumber;
  } else {
    delete out["showEpisodeNumber"];
  }
  if (widget.fields !== undefined && widget.fields.length > 0) {
    out["fields"] = widget.fields.map((f) => f.trim().toLowerCase()).filter((f) => f.length > 0);
    if ((out["fields"] as string[]).length === 0) {
      delete out["fields"];
    }
  } else {
    delete out["fields"];
  }

  // 使用单数 widget 形态写出（与示例配置一致）；删除 widgets 数组以免歧义
  target["widget"] = out;
  delete target["widgets"];
}

function extractDiskWidget(
  diskItem: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!diskItem) return null;
  if (
    diskItem["widget"] !== null &&
    typeof diskItem["widget"] === "object" &&
    !Array.isArray(diskItem["widget"])
  ) {
    return diskItem["widget"] as Record<string, unknown>;
  }
  if (Array.isArray(diskItem["widgets"])) {
    const first = diskItem["widgets"].find(
      (w) => w !== null && typeof w === "object" && !Array.isArray(w),
    );
    return first ? (first as Record<string, unknown>) : null;
  }
  return null;
}

function mergeServiceItem(
  editable: EditableServiceItemWrite,
  diskItem: Record<string, unknown> | null,
  path: string,
): Record<string, unknown> {
  void path;
  const base = diskItem ? deepClone(diskItem) : {};

  base["name"] = editable.name;

  if (editable.href !== undefined && editable.href.trim()) {
    base["href"] = editable.href.trim();
  } else {
    delete base["href"];
  }

  if (editable.target !== undefined) {
    base["target"] = editable.target;
  }

  if (editable.icon !== undefined && editable.icon.trim()) {
    base["icon"] = editable.icon.trim();
  } else if (editable.icon === undefined && diskItem && "icon" in diskItem) {
    // 保留
  } else {
    delete base["icon"];
  }
  // 更清晰：显式 undefined 保留磁盘；空串清除
  if (editable.icon !== undefined) {
    if (editable.icon.trim()) base["icon"] = editable.icon.trim();
    else delete base["icon"];
  }

  if (editable.description !== undefined) {
    if (editable.description.trim().length > 0) {
      base["description"] = editable.description.trim();
    } else {
      delete base["description"];
    }
  }

  if (editable.hidden === true) {
    base["hidden"] = true;
  } else {
    delete base["hidden"];
  }

  mergeHttpProbe(base, editable.httpProbe, diskItem);

  if (editable.docker !== undefined) {
    base["server"] = editable.docker.server;
    base["container"] = editable.docker.container;
  } else {
    // 编辑器未提供 docker 引用：清除支持字段
    delete base["server"];
    delete base["container"];
  }

  mergeWidget(base, editable.widget, diskItem);

  return base;
}

function mergeServices(
  disk: unknown,
  editable: EditableServiceGroupWrite[],
): unknown {
  // 输出数组形态：[{ GroupName: [items] }, ...]
  // 以编辑器顺序为准；条目按 name+index 对应磁盘以保留未知键
  const diskGroups = expandDiskGroups(disk);
  const result: Array<Record<string, unknown[]>> = [];

  for (let gi = 0; gi < editable.length; gi += 1) {
    const group = editable[gi];
    if (!group) continue;
    const groupName = group.name.trim();
    if (!groupName) {
      throw createFieldValidationError("服务分组名称不能为空", {
        file: "services.yaml",
        path: `services.${gi}.name`,
      });
    }

    const diskGroup = diskGroups.find((g) => g.name === groupName) ?? null;
    const items: unknown[] = [];

    for (let ii = 0; ii < group.items.length; ii += 1) {
      const item = group.items[ii];
      if (!item) continue;
      const diskItem =
        findDiskServiceItem(disk, groupName, item.name, ii) ??
        (diskGroup
          ? asRecord(diskGroup.items[ii])
          : null);

      // 歧义：同名多项且索引不匹配
      if (diskGroup) {
        const sameName = diskGroup.items
          .map((it) => asRecord(it))
          .filter((it): it is Record<string, unknown> => it !== null)
          .filter((it) => it["name"] === item.name);
        if (sameName.length > 1) {
          const indexed = asRecord(diskGroup.items[ii]);
          if (!indexed || indexed["name"] !== item.name) {
            throw createFieldValidationError(
              `服务条目无法安全对应：分组「${groupName}」中存在重复名称「${item.name}」`,
              {
                file: "services.yaml",
                path: `services.${gi}.items.${ii}`,
              },
            );
          }
        }
      }

      items.push(
        mergeServiceItem(item, diskItem, `services.${gi}.items.${ii}`),
      );
    }

    result.push({ [groupName]: items });
  }

  return result;
}

function mergeBookmarks(
  disk: unknown,
  editable: EditableBookmarkGroup[],
): unknown {
  const diskGroups = expandDiskGroups(disk);
  const result: Array<Record<string, unknown[]>> = [];

  for (let gi = 0; gi < editable.length; gi += 1) {
    const group = editable[gi];
    if (!group) continue;
    const groupName = group.name.trim();
    if (!groupName) {
      throw createFieldValidationError("书签分组名称不能为空", {
        file: "bookmarks.yaml",
        path: `bookmarks.${gi}.name`,
      });
    }

    const diskGroup = diskGroups.find((g) => g.name === groupName) ?? null;
    const items: unknown[] = [];

    for (let ii = 0; ii < group.items.length; ii += 1) {
      const item = group.items[ii];
      if (!item) continue;

      let diskItem: Record<string, unknown> | null = null;
      if (diskGroup) {
        const byIndex = asRecord(diskGroup.items[ii]);
        if (byIndex && byIndex["name"] === item.name) {
          diskItem = byIndex;
        } else {
          const matches = diskGroup.items
            .map((it) => asRecord(it))
            .filter((it): it is Record<string, unknown> => it !== null)
            .filter((it) => it["name"] === item.name);
          if (matches.length === 1) {
            diskItem = matches[0] ?? null;
          } else if (matches.length > 1) {
            throw createFieldValidationError(
              `书签条目无法安全对应：分组「${groupName}」中存在重复名称「${item.name}」`,
              {
                file: "bookmarks.yaml",
                path: `bookmarks.${gi}.items.${ii}`,
              },
            );
          }
        }
      }

      const base = diskItem ? deepClone(diskItem) : {};
      base["name"] = item.name;
      base["href"] = item.href;
      if (item.target !== undefined) base["target"] = item.target;
      if (item.icon !== undefined) {
        if (item.icon.trim()) base["icon"] = item.icon.trim();
        else delete base["icon"];
      }
      if (item.abbr !== undefined) {
        if (item.abbr.trim()) base["abbr"] = item.abbr.trim();
        else delete base["abbr"];
      }
      if (item.description !== undefined) {
        if (item.description.trim().length > 0) {
          base["description"] = item.description.trim();
        } else {
          delete base["description"];
        }
      }
      items.push(base);
    }

    result.push({ [groupName]: items });
  }

  return result;
}

function mergeInfoWidgets(
  disk: unknown,
  editable: EditableInfoWidget[],
): unknown {
  // 以数组形态输出；尽量按索引对应磁盘条目以保留未知键
  const diskEntries = extractDiskInfoEntries(disk);
  const result: unknown[] = [];

  for (let i = 0; i < editable.length; i += 1) {
    const w = editable[i];
    if (!w) continue;
    const diskEntry = diskEntries[i] ?? null;
    const base = diskEntry ? deepClone(diskEntry) : {};

    // 清理 type 简写形态，统一 type 字段
    base["type"] = w.type;

    if (w.type === "datetime") {
      if (w.timezone !== undefined) base["timezone"] = w.timezone;
      else delete base["timezone"];
      if (w.label !== undefined) base["label"] = w.label;
      else delete base["label"];
      if (w.format !== undefined) base["format"] = w.format;
      else delete base["format"];
    } else if (w.type === "openmeteo") {
      base["cityId"] = w.cityId;
      base["location"] = w.location;
      delete base["latitude"];
      delete base["longitude"];
      delete base["timezone"];
      if (w.label !== undefined) base["label"] = w.label;
      else delete base["label"];
    } else if (w.type === "resources") {
      if (w.cpu !== undefined) base["cpu"] = w.cpu;
      if (w.memory !== undefined) base["memory"] = w.memory;
      if (w.label !== undefined) base["label"] = w.label;
      else delete base["label"];
      if (w.disk !== undefined) {
        // 规范化为 path|label 字符串或 {path,label}，统一写入 disk
        const disk = w.disk;
        if (typeof disk === "string") {
          base["disk"] = disk;
        } else {
          base["disk"] = disk.map((item) => {
            if (typeof item === "string") return item;
            const label = item.label?.trim();
            if (label && label.length > 0) {
              return { path: item.path, label };
            }
            return item.path;
          });
        }
        delete base["diskPath"];
        delete base["diskPaths"];
        delete base["disks"];
      } else {
        delete base["disk"];
        delete base["diskPath"];
        delete base["diskPaths"];
        delete base["disks"];
      }
    }

    result.push(base);
  }

  return result;
}

function extractDiskInfoEntries(disk: unknown): Array<Record<string, unknown>> {
  if (disk === null || disk === undefined) return [];
  if (Array.isArray(disk)) {
    return disk
      .map((e) => asRecord(e))
      .filter((e): e is Record<string, unknown> => e !== null);
  }
  if (typeof disk === "object") {
    const entries: Array<Record<string, unknown>> = [];
    for (const [key, value] of Object.entries(disk as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if (typeof obj["type"] === "string") {
          entries.push(deepClone(obj));
        } else {
          entries.push({ type: key, ...deepClone(obj) });
        }
      } else if (value === null || value === undefined) {
        entries.push({ type: key });
      }
    }
    return entries;
  }
  return [];
}

function mergeDocker(
  disk: unknown,
  editable: EditableDockerEndpoint[],
): Record<string, unknown> {
  // 以原始映射为基底
  const base: Record<string, unknown> =
    disk !== null &&
    disk !== undefined &&
    typeof disk === "object" &&
    !Array.isArray(disk)
      ? deepClone(disk as Record<string, unknown>)
      : {};

  const editorNames = new Set(
    editable.map((e) => e.name.trim()).filter((n) => n.length > 0),
  );

  // 删除编辑器中已移除的端点
  for (const key of Object.keys(base)) {
    if (!editorNames.has(key)) {
      delete base[key];
    }
  }

  // 更新/新增：未修改端点保持插入顺序（对象键序）；新端口追加
  for (const ep of editable) {
    const name = ep.name.trim();
    if (!name) {
      throw createFieldValidationError("Docker 端点名称不能为空", {
        file: "docker.yaml",
        path: "dockerEndpoints",
      });
    }
    base[name] = ep.connection;
  }

  return base;
}

/**
 * 以原始解析树为基底，仅更新编辑器支持字段；未知键原样保留。
 */
export function mergeEditableIntoSources(
  writePayload: EditableConfigWrite,
  diskSources: ParsedConfigSources,
): ParsedConfigSources {
  return {
    settings: mergeSettings(diskSources.settings, writePayload.settings),
    services: mergeServices(diskSources.services, writePayload.services),
    bookmarks: mergeBookmarks(diskSources.bookmarks, writePayload.bookmarks),
    widgets: mergeInfoWidgets(diskSources.widgets, writePayload.infoWidgets),
    docker: mergeDocker(diskSources.docker, writePayload.dockerEndpoints),
    presentFiles: [...diskSources.presentFiles],
    missingFiles: [...diskSources.missingFiles],
  };
}
