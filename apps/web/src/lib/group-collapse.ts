const STORAGE_KEY = "homepage-group-collapse";

type CollapseMap = Record<string, boolean>;

function storageKey(scope: string, groupName: string): string {
  return `${scope}:${groupName}`;
}

function readMap(): CollapseMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: CollapseMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeMap(map: CollapseMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode / 配额等 */
  }
}

/** 读取分组是否折叠；默认展开 */
export function readGroupCollapsed(scope: string, groupName: string): boolean {
  return readMap()[storageKey(scope, groupName)] === true;
}

/** 写入分组折叠状态 */
export function writeGroupCollapsed(
  scope: string,
  groupName: string,
  collapsed: boolean,
): void {
  const map = readMap();
  const key = storageKey(scope, groupName);
  if (collapsed) {
    map[key] = true;
  } else {
    delete map[key];
  }
  writeMap(map);
}
