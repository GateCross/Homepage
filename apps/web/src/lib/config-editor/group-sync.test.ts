import { describe, expect, it } from "vitest";

import type {
  EditableBookmarkGroup,
  EditableConfigWrite,
  EditableLayoutEntry,
  EditableServiceGroupWrite,
} from "@/lib/contracts";

import {
  reconcileInitialDraft,
  syncBookmarksToLayout,
  syncLayoutToBookmarks,
  syncLayoutToServices,
  syncServicesToLayout,
} from "./group-sync";

describe("group-sync 联动同步", () => {
  it("服务页改名自动同步至设置页布局配置，且保留书签分组", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
      { groupName: "PT", maxColumns: 8 },
      { groupName: "B", maxColumns: 4 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [
      { name: "A", items: [] },
      { name: "B", items: [] },
    ];
    const nextServices: EditableServiceGroupWrite[] = [
      { name: "A_Renamed", items: [] },
      { name: "B", items: [] },
    ];

    const result = syncServicesToLayout(
      prevLayout,
      prevServices,
      nextServices,
      ["PT"],
    );
    expect(result).toEqual([
      { groupName: "A_Renamed", maxColumns: 6 },
      { groupName: "PT", maxColumns: 8 },
      { groupName: "B", maxColumns: 4 },
    ]);
  });

  it("服务页新增分组自动同步至设置页", () => {
    const prevLayout: EditableLayoutEntry[] = [{ groupName: "A", maxColumns: 6 }];
    const prevServices: EditableServiceGroupWrite[] = [{ name: "A", items: [] }];
    const nextServices: EditableServiceGroupWrite[] = [
      { name: "A", items: [] },
      { name: "NewGroup", items: [] },
    ];

    const result = syncServicesToLayout(prevLayout, prevServices, nextServices);
    expect(result).toEqual([
      { groupName: "A", maxColumns: 6 },
      { groupName: "NewGroup", maxColumns: 4 },
    ]);
  });

  it("服务页删除分组不会误删书签分组", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
      { groupName: "PT", maxColumns: 8 },
      { groupName: "B", maxColumns: 4 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [
      { name: "A", items: [] },
      { name: "B", items: [] },
    ];
    const nextServices: EditableServiceGroupWrite[] = [{ name: "B", items: [] }];

    const result = syncServicesToLayout(
      prevLayout,
      prevServices,
      nextServices,
      ["PT"],
    );
    expect(result).toEqual([
      { groupName: "PT", maxColumns: 8 },
      { groupName: "B", maxColumns: 4 },
    ]);
  });

  it("服务页排序调整自动同步至设置页服务相对顺序，且保留书签分组位置", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
      { groupName: "PT", maxColumns: 8 },
      { groupName: "B", maxColumns: 4 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [
      { name: "A", items: [] },
      { name: "B", items: [] },
    ];
    const nextServices: EditableServiceGroupWrite[] = [
      { name: "B", items: [] },
      { name: "A", items: [] },
    ];

    const result = syncServicesToLayout(
      prevLayout,
      prevServices,
      nextServices,
      ["PT"],
    );
    expect(result.map((r) => r.groupName)).toEqual(["B", "PT", "A"]);
  });

  it("书签页分组变更也能同步更新布局列表", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "Server", maxColumns: 6 },
      { groupName: "PT", maxColumns: 8 },
    ];
    const prevBookmarks: EditableBookmarkGroup[] = [
      { name: "PT", items: [] },
    ];
    const nextBookmarks: EditableBookmarkGroup[] = [
      { name: "PT_New", items: [] },
    ];

    const result = syncBookmarksToLayout(
      prevLayout,
      prevBookmarks,
      nextBookmarks,
      ["Server"],
    );
    expect(result).toEqual([
      { groupName: "Server", maxColumns: 6 },
      { groupName: "PT_New", maxColumns: 8 },
    ]);
  });

  it("设置页改名自动同步至服务页分组名称（非书签）", () => {
    const prevLayout: EditableLayoutEntry[] = [{ groupName: "A", maxColumns: 6 }];
    const nextLayout: EditableLayoutEntry[] = [
      { groupName: "A_New", maxColumns: 6 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [
      { name: "A", items: [{ name: "s1" }] },
    ];

    const result = syncLayoutToServices(prevLayout, nextLayout, prevServices);
    expect(result[0]!.name).toBe("A_New");
    expect(result[0]!.items[0]!.name).toBe("s1");
  });

  it("设置页中出现的书签分组绝不会被作为新服务加入服务页", () => {
    const prevLayout: EditableLayoutEntry[] = [{ groupName: "A", maxColumns: 6 }];
    const nextLayout: EditableLayoutEntry[] = [
      { groupName: "PT", maxColumns: 8 },
      { groupName: "A", maxColumns: 6 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [{ name: "A", items: [] }];

    const result = syncLayoutToServices(
      prevLayout,
      nextLayout,
      prevServices,
      ["PT"],
    );
    // PT 是书签分组，不应作为新服务添加到 services 中
    expect(result.map((g) => g.name)).toEqual(["A"]);
  });

  it("设置页排序调整同步更新书签页顺序", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "BM1", maxColumns: 4 },
      { groupName: "BM2", maxColumns: 4 },
    ];
    const nextLayout: EditableLayoutEntry[] = [
      { groupName: "BM2", maxColumns: 4 },
      { groupName: "BM1", maxColumns: 4 },
    ];
    const prevBookmarks: EditableBookmarkGroup[] = [
      { name: "BM1", items: [] },
      { name: "BM2", items: [] },
    ];

    const result = syncLayoutToBookmarks(prevLayout, nextLayout, prevBookmarks);
    expect(result.map((g) => g.name)).toEqual(["BM2", "BM1"]);
  });

  it("初始草稿对齐完整保留服务与书签分组既有顺序并补充缺失分组", () => {
    const draft: EditableConfigWrite = {
      settings: {
        title: "T",
        useEqualHeights: true,
        layout: [
          { groupName: "PT", maxColumns: 8 },
          { groupName: "Server", maxColumns: 6 },
        ],
      },
      services: [
        { name: "Server", items: [] },
        { name: "Docker", items: [] },
      ],
      bookmarks: [{ name: "PT", items: [] }],
      infoWidgets: [],
      dockerEndpoints: [],
    };

    const reconciled = reconcileInitialDraft(draft);
    expect(reconciled.settings.layout).toEqual([
      { groupName: "PT", maxColumns: 8 },
      { groupName: "Server", maxColumns: 6 },
      { groupName: "Docker", maxColumns: 4 },
    ]);
  });
});
