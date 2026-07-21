import {
  CANONICAL_VERSION,
  joinCanonicalParts,
  normalizeAbsoluteHttpUrl,
  sha256Hex,
  STABLE_ID_HASH_HEX_LENGTH,
  type BookmarkGroup,
  type BookmarkGroupItem,
  type NormalizedBookmark,
} from "@homepage/domain";

const SAFE_TARGETS = new Set(["_blank", "_self", "_parent", "_top"]);

const DEFAULT_TARGET = "_blank";

const BOOKMARK_ID_PREFIX = "bmk_" as const;

/** 生成稳定书签 ID。 身份：bookmarks + 分组索引 + 条目索引 + 规范化绝对 href。 名称、描述、图标、abbr、target 等展示字段不参与。 */
export function buildBookmarkId(
  groupIndex: number,
  itemIndex: number,
  normalizedHref: string,
): string {
  const canonical = joinCanonicalParts([
    CANONICAL_VERSION,
    "bookmark",
    "bookmarks",
    groupIndex,
    itemIndex,
    normalizedHref,
  ]);
  const hex = sha256Hex(canonical).slice(0, STABLE_ID_HASH_HEX_LENGTH);
  return `${BOOKMARK_ID_PREFIX}${hex}`;
}

function normalizeBookmarkName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBookmarkHref(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  return normalizeAbsoluteHttpUrl(raw);
}

function normalizeBookmarkTarget(raw: unknown): string {
  if (typeof raw !== "string") {
    return DEFAULT_TARGET;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return DEFAULT_TARGET;
  }
  return SAFE_TARGETS.has(trimmed) ? trimmed : DEFAULT_TARGET;
}

function normalizeOptionalNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBookmarkDescription(raw: unknown): string | undefined {
  return normalizeOptionalNonEmptyString(raw);
}

export function normalizeBookmarkItem(
  raw: unknown,
  groupIndex: number,
  itemIndex: number,
): BookmarkGroupItem {
  if (
    raw === null ||
    raw === undefined ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    return {
      kind: "error",
      message: "书签条目格式无效，须为包含 name 与 href 的对象",
    };
  }

  const source = raw as Record<string, unknown>;

  const name = normalizeBookmarkName(source["name"]);
  if (name === null) {
    return {
      kind: "error",
      message: "书签名称无效或为空",
    };
  }

  const href = normalizeBookmarkHref(source["href"]);
  if (href === null) {
    return {
      kind: "error",
      message: "书签链接无效，须为绝对 HTTP 或 HTTPS URL",
    };
  }

  const id = buildBookmarkId(groupIndex, itemIndex, href);
  const target = normalizeBookmarkTarget(source["target"]);
  const icon = normalizeOptionalNonEmptyString(source["icon"]);
  const abbr = normalizeOptionalNonEmptyString(source["abbr"]);
  const description = normalizeBookmarkDescription(source["description"]);

  const bookmark: NormalizedBookmark = {
    id,
    name,
    href,
    target,
  };

  if (icon !== undefined) {
    bookmark.icon = icon;
  }
  if (abbr !== undefined) {
    bookmark.abbr = abbr;
  }
  if (description !== undefined) {
    bookmark.description = description;
  }

  return bookmark;
}

function normalizeGroupItems(
  rawItems: unknown,
  groupIndex: number,
): BookmarkGroupItem[] {
  if (!Array.isArray(rawItems)) {
    // 分组值非数组：视为无条目，不使整文件失败
    return [];
  }

  return rawItems.map((item, itemIndex) =>
    normalizeBookmarkItem(item, groupIndex, itemIndex),
  );
}

function pushGroup(
  groups: BookmarkGroup[],
  groupName: string,
  rawItems: unknown,
  groupIndex: number,
): void {
  const name = groupName.trim();
  if (name.length === 0) {
    return;
  }
  groups.push({
    name,
    items: normalizeGroupItems(rawItems, groupIndex),
  });
}

function expandArrayGroupEntry(
  entry: unknown,
): { name: string; items: unknown }[] {
  if (
    entry === null ||
    entry === undefined ||
    typeof entry !== "object" ||
    Array.isArray(entry)
  ) {
    return [];
  }
  const result: { name: string; items: unknown }[] = [];
  for (const [key, value] of Object.entries(
    entry as Record<string, unknown>,
  )) {
    result.push({ name: key, items: value });
  }
  return result;
}

export function normalizeBookmarks(raw: unknown): BookmarkGroup[] {
  if (raw === null || raw === undefined) {
    return [];
  }

  const groups: BookmarkGroup[] = [];
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
        pushGroup(groups, name, items, indexForId);
      }
    }
    return groups;
  }

  if (typeof raw === "object") {
    // 顶层映射形态：按键序作为分组声明顺序
    for (const [name, items] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      const indexForId = groupIndex;
      groupIndex += 1;
      pushGroup(groups, name, items, indexForId);
    }
    return groups;
  }

  // 标量等：顶层结构校验本应已拦截；此处安全回退为空
  return [];
}
