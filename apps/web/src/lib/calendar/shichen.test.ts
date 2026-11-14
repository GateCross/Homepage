/**
 * 十二时辰：整点边界与子时跨日语义。
 * 子时为 23:00–01:00，其余各时辰按两小时均分。
 */
import { describe, expect, it } from "vitest";

import { shichenFromDate } from "./shichen";

/** 用上海时间某时刻构造 Date */
function at(hour: number, minute = 0): Date {
  return new Date(
    `2025-06-15T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
  );
}

describe("shichenFromDate 整点边界", () => {
  it("子时覆盖 23:00–01:00", () => {
    expect(shichenFromDate(at(23, 0), "Asia/Shanghai")?.name).toBe("子");
    expect(shichenFromDate(at(23, 59), "Asia/Shanghai")?.name).toBe("子");
    expect(shichenFromDate(at(0, 0), "Asia/Shanghai")?.name).toBe("子");
    expect(shichenFromDate(at(0, 59), "Asia/Shanghai")?.name).toBe("子");
  });

  it("丑时从 01:00 起", () => {
    expect(shichenFromDate(at(1, 0), "Asia/Shanghai")?.name).toBe("丑");
    expect(shichenFromDate(at(2, 59), "Asia/Shanghai")?.name).toBe("丑");
  });

  it("午时覆盖 11:00–13:00", () => {
    expect(shichenFromDate(at(11, 0), "Asia/Shanghai")?.name).toBe("午");
    expect(shichenFromDate(at(12, 59), "Asia/Shanghai")?.name).toBe("午");
  });

  it("亥时为 21:00–23:00", () => {
    expect(shichenFromDate(at(21, 0), "Asia/Shanghai")?.name).toBe("亥");
    expect(shichenFromDate(at(22, 59), "Asia/Shanghai")?.name).toBe("亥");
  });

  it("每个时辰恰好连续两个整点", () => {
    const seen: string[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const info = shichenFromDate(at(hour), "Asia/Shanghai");
      expect(info).not.toBeNull();
      seen.push(info!.name);
    }
    // 24 小时按两小时一格，共 12 个时辰各出现两次
    expect(seen).toHaveLength(24);
    const counts = new Map<string, number>();
    for (const name of seen) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    expect(counts.size).toBe(12);
    for (const count of counts.values()) {
      expect(count).toBe(2);
    }
  });
});

describe("shichenFromDate 标签与时区", () => {
  it("label 为名称加「时」", () => {
    const info = shichenFromDate(at(12), "Asia/Shanghai");
    expect(info?.label).toBe("午时");
  });

  it("时区影响结果：同一时刻在不同时区可属不同时辰", () => {
    // UTC 04:00 = 上海 12:00（午时），仍是 UTC 的 04:00（寅时）
    const instant = new Date(Date.UTC(2025, 5, 15, 4, 0, 0));
    expect(shichenFromDate(instant, "Asia/Shanghai")?.name).toBe("午");
    expect(shichenFromDate(instant, "UTC")?.name).toBe("寅");
  });

  it("非法时区返回 null 而不抛错", () => {
    expect(shichenFromDate(new Date(), "Bad/Zone")).toBeNull();
  });
});
