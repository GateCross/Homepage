import type {
  EditableConfigWrite,
  EditableLayoutEntry,
  EditableServiceGroupWrite,
} from "@/lib/contracts";

/**
 * 当服务页分组发生变更（增/删/改名/调序）时，同步对齐设置页的布局配置列表。
 */
export function syncServicesToLayout(
  prevLayout: EditableLayoutEntry[],
  prevServices: EditableServiceGroupWrite[],
  nextServices: EditableServiceGroupWrite[],
): EditableLayoutEntry[] {
  const prevNames = prevServices.map((g) => g.name?.trim()).filter(Boolean);
  const nextNames = nextServices.map((g) => g.name?.trim()).filter(Boolean);

  const prevNameSet = new Set(prevNames);
  const nextNameSet = new Set(nextNames);

  // 精准识别重命名：长度相等且恰好一旧换一新
  const renameMap = new Map<string, string>();
  if (prevNames.length === nextNames.length) {
    const missingInNext = prevNames.filter((name) => !nextNameSet.has(name));
    const addedInNext = nextNames.filter((name) => !prevNameSet.has(name));
    if (missingInNext.length === 1 && addedInNext.length === 1) {
      renameMap.set(missingInNext[0]!, addedInNext[0]!);
    }
  }

  // 1. 更新布局中已有项的名称
  let updatedLayout = prevLayout.map((entry) => {
    const renamed = renameMap.get(entry.groupName);
    return renamed ? { ...entry, groupName: renamed } : entry;
  });

  // 2. 剔除在新服务分组中已被彻底移除的分组
  updatedLayout = updatedLayout.filter((entry) =>
    nextNameSet.has(entry.groupName),
  );

  // 3. 为新增加的服务分组补充默认最大列数配置（默认 4 列）
  const existingNames = new Set(updatedLayout.map((e) => e.groupName));
  for (const name of nextNames) {
    if (!existingNames.has(name)) {
      updatedLayout.push({ groupName: name, maxColumns: 4 });
      existingNames.add(name);
    }
  }

  // 4. 将设置页的布局项顺序严格对齐服务页的分组顺序
  const orderMap = new Map<string, number>();
  nextNames.forEach((name, i) => orderMap.set(name, i));
  updatedLayout.sort((a, b) => {
    const oa = orderMap.get(a.groupName) ?? 999;
    const ob = orderMap.get(b.groupName) ?? 999;
    return oa - ob;
  });

  return updatedLayout;
}

/**
 * 当设置页布局配置发生变更（改名/新增/调序）时，同步更新服务页的服务分组数据。
 */
export function syncLayoutToServices(
  prevLayout: EditableLayoutEntry[],
  nextLayout: EditableLayoutEntry[],
  prevServices: EditableServiceGroupWrite[],
): EditableServiceGroupWrite[] {
  const prevNames = prevLayout.map((r) => r.groupName?.trim()).filter(Boolean);
  const nextNames = nextLayout.map((r) => r.groupName?.trim()).filter(Boolean);

  const prevNameSet = new Set(prevNames);
  const nextNameSet = new Set(nextNames);

  // 精准识别重命名：长度相等且恰好一旧换一新
  const renameMap = new Map<string, string>();
  if (prevNames.length === nextNames.length) {
    const missingInNext = prevNames.filter((name) => !nextNameSet.has(name));
    const addedInNext = nextNames.filter((name) => !prevNameSet.has(name));
    if (missingInNext.length === 1 && addedInNext.length === 1) {
      renameMap.set(missingInNext[0]!, addedInNext[0]!);
    }
  }

  // 1. 将改名应用到服务分组列表
  const nextServices = prevServices.map((g) => {
    const renamed = renameMap.get(g.name?.trim());
    return renamed ? { ...g, name: renamed } : g;
  });

  // 2. 识别新增的分组（在 nextLayout 中有，但在 services 中没有）
  const serviceNames = new Set(
    nextServices.map((g) => g.name?.trim()).filter(Boolean),
  );
  for (const name of nextNames) {
    if (!serviceNames.has(name)) {
      nextServices.push({
        name,
        items: [{ name: "新服务" }],
      });
      serviceNames.add(name);
    }
  }

  // 3. 按照设置页布局的顺序对齐服务分组排序
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
 * 初始加载草稿时，确保服务分组与设置页布局配置完全对齐（包含所有服务分组且顺序一致）。
 */
export function reconcileInitialDraft(
  draft: EditableConfigWrite,
): EditableConfigWrite {
  const syncedLayout = syncServicesToLayout(
    draft.settings.layout,
    draft.services,
    draft.services,
  );
  return {
    ...draft,
    settings: {
      ...draft.settings,
      layout: syncedLayout,
    },
  };
}
