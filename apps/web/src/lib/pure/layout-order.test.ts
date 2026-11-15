import { describe, expect, it } from "vitest";

import type { BookmarkGroup, ServiceGroup } from "@/lib/contracts";
import { buildDashboardSectionChunks } from "./layout-order";

describe("buildDashboardSectionChunks", () => {
  const dummyServices: ServiceGroup[] = [
    { name: "Server", items: [{ id: "1", name: "1Panel", target: "_blank" }] },
    { name: "Docker", items: [{ id: "2", name: "qBit", target: "_blank" }] },
  ];

  const dummyBookmarks: BookmarkGroup[] = [
    {
      name: "PT",
      items: [
        { id: "3", name: "HDSky", href: "https://hdsky.me", target: "_blank" },
      ],
    },
    {
      name: "Common",
      items: [
        { id: "4", name: "GitHub", href: "https://github.com", target: "_blank" },
      ],
    },
  ];

  it("当未配置 layoutOrder 时，保持默认顺序：服务在前、书签在后", () => {
    const chunks = buildDashboardSectionChunks(dummyServices, dummyBookmarks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.type).toBe("service");
    expect(chunks[0]!.groups.map((g) => g.name)).toEqual(["Server", "Docker"]);
    expect(chunks[1]!.type).toBe("bookmark");
    expect(chunks[1]!.groups.map((g) => g.name)).toEqual(["PT", "Common"]);
  });

  it("当 layoutOrder 中书签在前时，书签分组优先排在上方", () => {
    const chunks = buildDashboardSectionChunks(dummyServices, dummyBookmarks, [
      "PT",
      "Common",
      "Server",
      "Docker",
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.type).toBe("bookmark");
    expect(chunks[0]!.groups.map((g) => g.name)).toEqual(["PT", "Common"]);
    expect(chunks[1]!.type).toBe("service");
    expect(chunks[1]!.groups.map((g) => g.name)).toEqual(["Server", "Docker"]);
  });

  it("支持服务与书签分组交替穿插排布", () => {
    const chunks = buildDashboardSectionChunks(dummyServices, dummyBookmarks, [
      "Server",
      "PT",
      "Docker",
      "Common",
    ]);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.type).toBe("service");
    expect(chunks[0]!.groups.map((g) => g.name)).toEqual(["Server"]);
    expect(chunks[1]!.type).toBe("bookmark");
    expect(chunks[1]!.groups.map((g) => g.name)).toEqual(["PT"]);
    expect(chunks[2]!.type).toBe("service");
    expect(chunks[2]!.groups.map((g) => g.name)).toEqual(["Docker"]);
    expect(chunks[3]!.type).toBe("bookmark");
    expect(chunks[3]!.groups.map((g) => g.name)).toEqual(["Common"]);
  });

  it("未在 layoutOrder 中指定的分组按声明顺序在末尾追加", () => {
    const chunks = buildDashboardSectionChunks(dummyServices, dummyBookmarks, [
      "Docker",
    ]);
    // 预期顺序：Docker (服务) -> Server (未声明服务) -> PT (未声明书签) -> Common (未声明书签)
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.type).toBe("service");
    expect(chunks[0]!.groups.map((g) => g.name)).toEqual(["Docker", "Server"]);
    expect(chunks[1]!.type).toBe("bookmark");
    expect(chunks[1]!.groups.map((g) => g.name)).toEqual(["PT", "Common"]);
  });
});
