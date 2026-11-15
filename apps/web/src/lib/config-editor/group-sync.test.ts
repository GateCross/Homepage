import { describe, expect, it } from "vitest";

import type {
  EditableConfigWrite,
  EditableLayoutEntry,
  EditableServiceGroupWrite,
} from "@/lib/contracts";

import {
  reconcileInitialDraft,
  syncLayoutToServices,
  syncServicesToLayout,
} from "./group-sync";

describe("group-sync 联动同步", () => {
  it("服务页改名自动同步至设置页布局配置", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
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

    const result = syncServicesToLayout(prevLayout, prevServices, nextServices);
    expect(result).toEqual([
      { groupName: "A_Renamed", maxColumns: 6 },
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

  it("服务页删除分组自动从设置页移除", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
      { groupName: "B", maxColumns: 4 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [
      { name: "A", items: [] },
      { name: "B", items: [] },
    ];
    const nextServices: EditableServiceGroupWrite[] = [{ name: "B", items: [] }];

    const result = syncServicesToLayout(prevLayout, prevServices, nextServices);
    expect(result).toEqual([{ groupName: "B", maxColumns: 4 }]);
  });

  it("服务页排序调整自动同步至设置页布局顺序", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
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

    const result = syncServicesToLayout(prevLayout, prevServices, nextServices);
    expect(result.map((r) => r.groupName)).toEqual(["B", "A"]);
  });

  it("设置页改名自动同步至服务页分组名称", () => {
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

  it("设置页新增分组自动同步在服务页创建新分组", () => {
    const prevLayout: EditableLayoutEntry[] = [{ groupName: "A", maxColumns: 6 }];
    const nextLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
      { groupName: "B", maxColumns: 4 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [{ name: "A", items: [] }];

    const result = syncLayoutToServices(prevLayout, nextLayout, prevServices);
    expect(result.map((g) => g.name)).toEqual(["A", "B"]);
    expect(result[1]!.items).toHaveLength(1);
  });

  it("设置页排序调整自动同步至服务页顺序", () => {
    const prevLayout: EditableLayoutEntry[] = [
      { groupName: "A", maxColumns: 6 },
      { groupName: "B", maxColumns: 4 },
    ];
    const nextLayout: EditableLayoutEntry[] = [
      { groupName: "B", maxColumns: 4 },
      { groupName: "A", maxColumns: 6 },
    ];
    const prevServices: EditableServiceGroupWrite[] = [
      { name: "A", items: [] },
      { name: "B", items: [] },
    ];

    const result = syncLayoutToServices(prevLayout, nextLayout, prevServices);
    expect(result.map((g) => g.name)).toEqual(["B", "A"]);
  });

  it("初始草稿对齐补全未配置的服务分组并按服务顺序对齐", () => {
    const draft: EditableConfigWrite = {
      settings: {
        title: "T",
        useEqualHeights: true,
        layout: [{ groupName: "B", maxColumns: 8 }],
      },
      services: [
        { name: "A", items: [] },
        { name: "B", items: [] },
      ],
      bookmarks: [],
      infoWidgets: [],
      dockerEndpoints: [],
    };

    const reconciled = reconcileInitialDraft(draft);
    expect(reconciled.settings.layout).toEqual([
      { groupName: "A", maxColumns: 4 },
      { groupName: "B", maxColumns: 8 },
    ]);
  });
});
