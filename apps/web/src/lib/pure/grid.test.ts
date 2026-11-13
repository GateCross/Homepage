import { describe, expect, it } from "vitest";

import {
  BOOKMARK_MIN_ITEM_WIDTH_PX,
  SERVICE_MIN_ITEM_WIDTH_PX,
  resolveColumns,
} from "./grid";

describe("resolveColumns", () => {
  it("按容器宽度与最小卡片宽度取整列数", () => {
    expect(resolveColumns(4, 1000, 240)).toBe(4);
    expect(resolveColumns(4, 720, 240)).toBe(3);
    expect(resolveColumns(4, 479, 240)).toBe(1);
  });

  it("容器足够宽时受最大列数约束", () => {
    expect(resolveColumns(2, 4000, 240)).toBe(2);
  });

  it("容器宽度不足一张卡片仍保留 1 列", () => {
    expect(resolveColumns(4, 0, 240)).toBe(1);
    expect(resolveColumns(4, 100, 240)).toBe(1);
  });

  it("非法入参回落为 1 列而不是 NaN", () => {
    expect(resolveColumns(Number.NaN, 1000, 240)).toBe(1);
    expect(resolveColumns(4, Number.POSITIVE_INFINITY, 240)).toBe(1);
    expect(resolveColumns(4, 1000, Number.NaN)).toBe(4);
  });

  it("最小宽度非法时按 1px 兜底，容量不受限", () => {
    expect(resolveColumns(4, 1000, 0)).toBe(4);
    expect(resolveColumns(4, 1000, -240)).toBe(4);
  });

  it("列数下限恒为 1", () => {
    expect(resolveColumns(0, 1000, 240)).toBe(1);
    expect(resolveColumns(-3, 1000, 240)).toBe(1);
  });

  it("两个最小宽度常量保持稳定", () => {
    expect(SERVICE_MIN_ITEM_WIDTH_PX).toBe(240);
    expect(BOOKMARK_MIN_ITEM_WIDTH_PX).toBe(160);
  });
});
