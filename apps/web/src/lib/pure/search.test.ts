import { describe, expect, it } from "vitest";

import { matchSearch, type SearchableItem } from "./search";

const items: SearchableItem[] = [
  {
    id: "a",
    name: "Jellyfin",
    href: "https://media.example.com/web",
    target: "_blank",
    description: "家庭影音",
  },
  {
    id: "b",
    name: "qBittorrent",
    href: "https://dl.example.com:8080",
    target: "_blank",
  },
  { id: "c", name: "路由器", target: "_self" },
];

describe("matchSearch", () => {
  it("空查询返回全部条目", () => {
    expect(matchSearch(items, "  ").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("名称大小写不敏感", () => {
    expect(matchSearch(items, "jelly").map((i) => i.id)).toEqual(["a"]);
    expect(matchSearch(items, "QBIT").map((i) => i.id)).toEqual(["b"]);
  });

  it("中文描述参与匹配", () => {
    expect(matchSearch(items, "影音").map((i) => i.id)).toEqual(["a"]);
  });

  it("hostname 参与匹配（不含端口）", () => {
    expect(matchSearch(items, "media.example").map((i) => i.id)).toEqual(["a"]);
    expect(matchSearch(items, "8080").map((i) => i.id)).toEqual(["b"]);
  });

  it("按 id 去重，保留首次出现", () => {
    const duplicated = [items[0]!, { ...items[0]!, name: "重复项" }];
    expect(matchSearch(duplicated, "").map((i) => i.name)).toEqual(["Jellyfin"]);
  });

  it("无命中返回空数组", () => {
    expect(matchSearch(items, "zzz")).toEqual([]);
  });
});
