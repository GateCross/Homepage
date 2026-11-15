import type { BookmarkGroup, ServiceGroup } from "@/lib/contracts";

export type DashboardSectionChunk =
  | { type: "service"; groups: ServiceGroup[] }
  | { type: "bookmark"; groups: BookmarkGroup[] };

/**
 * 依据 layoutOrder 定义的顺序编排首页服务分组与书签分组：
 * 1. 优先按 layoutOrder 声明顺序排布各分组（包含服务与书签）。
 * 2. 未在 layoutOrder 中声明的服务分组，按其原本声明顺序追加在后。
 * 3. 未在 layoutOrder 中声明的书签分组，按其原本声明顺序追加在最后。
 * 4. 连续的同类型分组会被聚合为一个区块，便于语义渲染与样式保持一致。
 */
export function buildDashboardSectionChunks(
  services: ServiceGroup[],
  bookmarks: BookmarkGroup[],
  layoutOrder?: string[],
): DashboardSectionChunk[] {
  // 如果未配置 layoutOrder，保持默认行为：全部服务在上，全部书签在下
  if (!layoutOrder || layoutOrder.length === 0) {
    const chunks: DashboardSectionChunk[] = [];
    if (services.length > 0) {
      chunks.push({ type: "service", groups: services });
    }
    if (bookmarks.length > 0) {
      chunks.push({ type: "bookmark", groups: bookmarks });
    }
    return chunks;
  }

  const serviceMap = new Map<string, ServiceGroup>();
  for (const group of services) {
    serviceMap.set(group.name.trim(), group);
  }

  const bookmarkMap = new Map<string, BookmarkGroup>();
  for (const group of bookmarks) {
    bookmarkMap.set(group.name.trim(), group);
  }

  const visitedServices = new Set<string>();
  const visitedBookmarks = new Set<string>();

  type FlatGroup =
    | { type: "service"; group: ServiceGroup }
    | { type: "bookmark"; group: BookmarkGroup };

  const orderedList: FlatGroup[] = [];

  // 按 layoutOrder 依次挑选服务或书签分组
  for (const rawName of layoutOrder) {
    const name = rawName.trim();
    if (!name) continue;

    if (serviceMap.has(name) && !visitedServices.has(name)) {
      orderedList.push({ type: "service", group: serviceMap.get(name)! });
      visitedServices.add(name);
    } else if (bookmarkMap.has(name) && !visitedBookmarks.has(name)) {
      orderedList.push({ type: "bookmark", group: bookmarkMap.get(name)! });
      visitedBookmarks.add(name);
    }
  }

  // 追加未在 layoutOrder 中显式列出的服务分组
  for (const group of services) {
    const name = group.name.trim();
    if (!visitedServices.has(name)) {
      orderedList.push({ type: "service", group });
      visitedServices.add(name);
    }
  }

  // 追加未在 layoutOrder 中显式列出的书签分组
  for (const group of bookmarks) {
    const name = group.name.trim();
    if (!visitedBookmarks.has(name)) {
      orderedList.push({ type: "bookmark", group });
      visitedBookmarks.add(name);
    }
  }

  // 将相邻同类型分组聚合为区块
  const chunks: DashboardSectionChunk[] = [];
  for (const item of orderedList) {
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk && lastChunk.type === item.type) {
      if (item.type === "service") {
        (lastChunk.groups as ServiceGroup[]).push(item.group);
      } else {
        (lastChunk.groups as BookmarkGroup[]).push(item.group);
      }
    } else {
      if (item.type === "service") {
        chunks.push({ type: "service", groups: [item.group] });
      } else {
        chunks.push({ type: "bookmark", groups: [item.group] });
      }
    }
  }

  return chunks;
}
