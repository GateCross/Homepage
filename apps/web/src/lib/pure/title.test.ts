import { describe, expect, it } from "vitest";

import { DEFAULT_DASHBOARD_TITLE, normalizeTitle } from "./title";

describe("normalizeTitle", () => {
  it("去掉首尾空白", () => {
    expect(normalizeTitle("  我的主页  ")).toBe("我的主页");
  });

  it("空串、纯空白与非字符串回落默认标题", () => {
    expect(normalizeTitle("")).toBe(DEFAULT_DASHBOARD_TITLE);
    expect(normalizeTitle("   ")).toBe(DEFAULT_DASHBOARD_TITLE);
    expect(normalizeTitle(undefined)).toBe(DEFAULT_DASHBOARD_TITLE);
    expect(normalizeTitle(42)).toBe(DEFAULT_DASHBOARD_TITLE);
  });

  it("默认标题为「首页」", () => {
    expect(DEFAULT_DASHBOARD_TITLE).toBe("首页");
  });
});
