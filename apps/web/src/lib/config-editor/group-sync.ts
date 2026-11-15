import type {
  EditableBookmarkGroup,
  EditableConfigWrite,
  EditableLayoutEntry,
  EditableServiceGroupWrite,
} from "@/lib/contracts";

/**
 * 识别分组单次重命名（原数组与新数组长度相等，且恰好一旧换一新）。
 */
function detectRename(
  prevNames: string[],
  nextNames: string[],
): Map<string, string> {
  const renameMap = new Map<string, string>();
  if (prevNames.length !== nextNames.length) return renameMap;

  const prevNameSet = new Set(prevNames);
  const nextNameSet = new Set(nextNames);

  const missingInNext = prevNames.filter((name) => !nextNameSet.has(name));
  const addedInNext = nextNames.filter((name) => !prevNameSet.has(name));
  if (missingInNext.length === 1 && addedInNext.length === 1) {
    renameMap.set(missingInNext[0]!, addedInNext[0]!);
  }
  return renameMap;
}

/**
 * 当服务页分组变更时，同步更新布局列表：
 * - 支持识别重命名；
 * - 只有既不在新服务分组、也不在书签分组的分组才会被剔除；
 * - 新增服务分组追加到末尾；
 * - 调整服务分组在布局中的相对顺序，保留书签分组的位置。
 */
export function syncServicesToLayout(
  prevLayout: EditableLayoutEntry[],
  prevServices: EditableServiceGroupWrite[],
  nextServices: EditableServiceGroupWrite[],
  bookmarkGroupNames: string[] = [],
): EditableLayoutEntry[] {
  const prevNames = prevServices.map((g) => g.name?.trim()).filter(Boolean);
  const nextNames = nextServices.map((g) => g.name?.trim()).filter(Boolean);
  const bookmarkNameSet = new Set(
    bookmarkGroupNames.map((n) => n.trim()).filter(Boolean),
  );
  const nextNameSet = new Set(nextNames);

  const renameMap = detectRename(prevNames, nextNames);

  // 1. 更新改名
  let updatedLayout = prevLayout.map((entry) => {
    const renamed = renameMap.get(entry.groupName);
    return renamed ? { ...entry, groupName: renamed } : entry;
  });

  // 2. 剔除：既不在新服务中，也不在书签中的分组
  updatedLayout = updatedLayout.filter(
    (entry) =>
      nextNameSet.has(entry.groupName) || bookmarkNameSet.has(entry.groupName),
  );

  // 3. 补充新服务分组
  const existingNames = new Set(updatedLayout.map((e) => e.groupName));
  for (const name of nextNames) {
    if (!existingNames.has(name)) {
      updatedLayout.push({ groupName: name, maxColumns: 4 });
      existingNames.add(name);
    }
  }

  // 4. 对齐服务分组在布局中的相对顺序，保持书签分组穿插位置不变
  const serviceRankMap = new Map<string, number>();
  nextNames.forEach((name, i) => serviceRankMap.set(name, i));

  const serviceIndices: number[] = [];
  const serviceEntries: EditableLayoutEntry[] = [];
  updatedLayout.forEach((entry, idx) => {
    if (serviceRankMap.has(entry.groupName)) {
      serviceIndices.push(idx);
      serviceEntries.push(entry);
    }
  });

  serviceEntries.sort((a, b) => {
    const ra = serviceRankMap.get(a.groupName) ?? 999;
    const rb = serviceRankMap.get(b.groupName) ?? 999;
    return ra - rb;
  });

  const finalLayout = [...updatedLayout];
  serviceIndices.forEach((pos, i) => {
    finalLayout[pos] = serviceEntries[i]!;
  });

  return finalLayout;
}

/**
 * 当书签页分组变更时，同步更新布局列表。
 */
export function syncBookmarksToLayout(
  prevLayout: EditableLayoutEntry[],
  prevBookmarks: EditableBookmarkGroup[],
  nextBookmarks: EditableBookmarkGroup[],
  serviceGroupNames: string[] = [],
): EditableLayoutEntry[] {
  const prevNames = prevBookmarks.map((g) => g.name?.trim()).filter(Boolean);
  const nextNames = nextBookmarks.map((g) => g.name?.trim()).filter(Boolean);
  const serviceNameSet = new Set(
    serviceGroupNames.map((n) => n.trim()).filter(Boolean),
  );
  const nextNameSet = new Set(nextNames);

  const renameMap = detectRename(prevNames, nextNames);

  let updatedLayout = prevLayout.map((entry) => {
    const renamed = renameMap.get(entry.groupName);
    return renamed ? { ...entry, groupName: renamed } : entry;
  });

  updatedLayout = updatedLayout.filter(
    (entry) =>
      nextNameSet.has(entry.groupName) || serviceNameSet.has(entry.groupName),
  );

  const existingNames = new Set(updatedLayout.map((e) => e.groupName));
  for (const name of nextNames) {
    if (!existingNames.has(name)) {
      updatedLayout.push({ groupName: name, maxColumns: 4 });
      existingNames.add(name);
    }
  }

  const bookmarkRankMap = new Map<string, number>();
  nextNames.forEach((name, i) => bookmarkRankMap.set(name, i));

  const bookmarkIndices: number[] = [];
  const bookmarkEntries: EditableLayoutEntry[] = [];
  updatedLayout.forEach((entry, idx) => {
    if (bookmarkRankMap.has(entry.groupName)) {
      bookmarkIndices.push(idx);
      bookmarkEntries.push(entry);
    }
  });

  bookmarkEntries.sort((a, b) => {
    const ra = bookmarkRankMap.get(a.groupName) ?? 999;
    const rb = bookmarkRankMap.get(b.groupName) ?? 999;
    return ra - rb;
  });

  const finalLayout = [...updatedLayout];
  bookmarkIndices.forEach((pos, i) => {
    finalLayout[pos] = bookmarkEntries[i]!;
  });

  return finalLayout;
}

/**
 * 当设置页布局变更（改名/调序）时，同步更新服务页分组：
 * - 仅更新属于服务的分组改名；
 * - 仅对服务分组按照其在布局中的相对顺序对齐；
 * - 绝不将书签分组误加到服务分组中。
 */
export function syncLayoutToServices(
  prevLayout: EditableLayoutEntry[],
  nextLayout: EditableLayoutEntry[],
  prevServices: EditableServiceGroupWrite[],
  bookmarkGroupNames: string[] = [],
): EditableServiceGroupWrite[] {
  const prevNames = prevLayout.map((r) => r.groupName?.trim()).filter(Boolean);
  const nextNames = nextLayout.map((r) => r.groupName?.trim()).filter(Boolean);
  const bookmarkSet = new Set(
    bookmarkGroupNames.map((n) => n.trim()).filter(Boolean),
  );

  const renameMap = detectRename(prevNames, nextNames);

  // 1. 将改名应用到服务分组
  const nextServices = prevServices.map((g) => {
    const renamed = renameMap.get(g.name?.trim());
    return renamed ? { ...g, name: renamed } : g;
  });

  // 2. 识别真正的新增服务分组（在 nextLayout 中有，但在 services 和 bookmarks 中都没有）
  const serviceNames = new Set(
    nextServices.map((g) => g.name?.trim()).filter(Boolean),
  );
  for (const name of nextNames) {
    if (!serviceNames.has(name) && !bookmarkSet.has(name)) {
      nextServices.push({
        name,
        items: [{ name: "新服务" }],
      });
      serviceNames.add(name);
    }
  }

  // 3. 按照布局顺序对服务分组排序
  const orderMap = new Map<string, number>();
  nextNames.forEach((name, i) => orderMap.set(name, i));
  nextServices.sort((a, b) => {
    const nameA = a.name?.trim() ?? "";
    const nameB = b.name?.trim() ?? "";
    const oa = orderMap.get(nameA) ?? 999;
    const ob = orderMap.get(nameB) ?? 999;
    return oa - ob;
  });

  return nextServices;
}

/**
 * 当设置页布局变更时，同步更新书签页分组：
 * - 仅更新属于书签的分组改名；
 * - 仅对书签分组按照其在布局中的相对顺序对齐。
 */
export function syncLayoutToBookmarks(
  prevLayout: EditableLayoutEntry[],
  nextLayout: EditableLayoutEntry[],
  prevBookmarks: EditableBookmarkGroup[],
): EditableBookmarkGroup[] {
  const prevNames = prevLayout.map((r) => r.groupName?.trim()).filter(Boolean);
  const nextNames = nextLayout.map((r) => r.groupName?.trim()).filter(Boolean);
  const renameMap = detectRename(prevNames, nextNames);

  const nextBookmarks = prevBookmarks.map((g) => {
    const renamed = renameMap.get(g.name?.trim());
    return renamed ? { ...g, name: renamed } : g;
  });

  const orderMap = new Map<string, number>();
  nextNames.forEach((name, i) => orderMap.set(name, i));
  nextBookmarks.sort((a, b) => {
    const nameA = a.name?.trim() ?? "";
    const nameB = b.name?.trim() ?? "";
    const oa = orderMap.get(nameA) ?? 999;
    const ob = orderMap.get(nameB) ?? 999;
    return oa - ob;
  });

  return nextBookmarks;
}

/**
 * 初始加载草稿时，确保服务分组与书签分组均在布局配置中：
 * 保持用户已有的顺序，仅对缺失的分组在末尾补齐。
 */
export function reconcileInitialDraft(
  draft: EditableConfigWrite,
): EditableConfigWrite {
  const serviceNames = draft.services
    .map((g) => g.name?.trim())
    .filter(Boolean);
  const bookmarkNames = draft.bookmarks
    .map((g) => g.name?.trim())
    .filter(Boolean);
  const allKnownNames = new Set([...serviceNames, ...bookmarkNames]);

  // 保留 layout 中已有的有效分组（属于服务或书签），保持其既有顺序
  const existingLayout = draft.settings.layout.filter((entry) =>
    allKnownNames.has(entry.groupName?.trim()),
  );

  const existingNames = new Set(existingLayout.map((e) => e.groupName.trim()));

  // 将未在布局中的服务分组补充在后
  for (const name of serviceNames) {
    if (!existingNames.has(name)) {
      existingLayout.push({ groupName: name, maxColumns: 4 });
      existingNames.add(name);
    }
  }

  // 将未在布局中的书签分组补充在后
  for (const name of bookmarkNames) {
    if (!existingNames.has(name)) {
      existingLayout.push({ groupName: name, maxColumns: 4 });
      existingNames.add(name);
    }
  }

  return {
    ...draft,
    settings: {
      ...draft.settings,
      layout: existingLayout,
    },
  };
}
