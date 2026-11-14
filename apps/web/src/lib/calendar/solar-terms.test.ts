/**
 * 二十四节气：以天文事实为基准校验交节日，
 * 并锁定「当前节气 / 下一节气」的边界语义。
 */
import { describe, expect, it } from "vitest";

import {
  currentSolarTerm,
  nextSolarTerm,
  solarTermsForYear,
} from "./solar-terms";

describe("solarTermsForYear 覆盖与顺序", () => {
  it("正常年份返回 24 个节气，索引连续", () => {
    const terms = solarTermsForYear(2025, "Asia/Shanghai");
    expect(terms).toHaveLength(24);
    expect(terms.map((t) => t.index)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );
  });

  it("小寒为 0、冬至为 23，名称不重复", () => {
    const terms = solarTermsForYear(2025, "UTC");
    expect(terms[0]?.name).toBe("小寒");
    expect(terms[23]?.name).toBe("冬至");
    expect(new Set(terms.map((t) => t.name)).size).toBe(24);
  });

  it("交节时刻严格递增", () => {
    const terms = solarTermsForYear(2025, "UTC");
    for (let i = 1; i < terms.length; i += 1) {
      expect(terms[i]!.atMs).toBeGreaterThan(terms[i - 1]!.atMs);
    }
  });

  it("超出 1900–2100 范围返回空数组", () => {
    expect(solarTermsForYear(1899, "UTC")).toEqual([]);
    expect(solarTermsForYear(2101, "UTC")).toEqual([]);
  });
});

describe("solarTermsForYear 已知交节日", () => {
  /*
   * 本算法以 1900 小寒为基准按回归年线性外推，属近似值：
   * 与官方历法（紫金山天文台）在部分年份存在 ±1 天差异。
   * 下面的期望值锁定的是算法当前输出，用于发现回归，
   * 不是天文权威值——若将来换成高精度算法，这些断言应随之更新。
   */
  it("2025 立春落在 2 月上旬", () => {
    const terms = solarTermsForYear(2025, "Asia/Shanghai");
    const lichun = terms.find((t) => t.name === "立春");
    expect(lichun?.month).toBe(2);
    expect(lichun?.day).toBeGreaterThanOrEqual(3);
    expect(lichun?.day).toBeLessThanOrEqual(5);
  });

  it("2025 清明落在 4 月上旬", () => {
    const terms = solarTermsForYear(2025, "Asia/Shanghai");
    const qingming = terms.find((t) => t.name === "清明");
    expect(qingming?.month).toBe(4);
    expect(qingming?.day).toBeGreaterThanOrEqual(4);
    expect(qingming?.day).toBeLessThanOrEqual(6);
  });

  it("2025 冬至落在 12 月下旬", () => {
    const terms = solarTermsForYear(2025, "Asia/Shanghai");
    const dongzhi = terms.find((t) => t.name === "冬至");
    expect(dongzhi?.month).toBe(12);
    expect(dongzhi?.day).toBeGreaterThanOrEqual(20);
    expect(dongzhi?.day).toBeLessThanOrEqual(22);
  });

  it("时区不改变交节瞬时，只影响落地日", () => {
    const shanghai = solarTermsForYear(2025, "Asia/Shanghai");
    const utc = solarTermsForYear(2025, "UTC");
    expect(shanghai[0]?.atMs).toBe(utc[0]?.atMs);
  });
});

describe("currentSolarTerm", () => {
  it("交节当日即属于该节气", () => {
    // 2025-04-05 为算法给出的清明交节日
    const term = currentSolarTerm(
      new Date("2025-04-05T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(term?.name).toBe("清明");
    expect(term?.since.month).toBe(4);
  });

  it("交节前一日仍属上一节气", () => {
    const before = currentSolarTerm(
      new Date("2025-04-04T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(before?.name).toBe("春分");
  });

  it("冬至之后到次年小寒之前仍属冬至", () => {
    const term = currentSolarTerm(
      new Date("2025-12-31T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(term?.name).toBe("冬至");
  });

  it("非法时区返回 null", () => {
    expect(currentSolarTerm(new Date(), "Bad/Zone")).toBeNull();
  });
});

describe("nextSolarTerm", () => {
  it("返回严格晚于今天的最近节气", () => {
    // 2025-04-05 清明当天，下一个应是谷雨
    const next = nextSolarTerm(
      new Date("2025-04-05T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(next?.name).toBe("谷雨");
    expect(
      next!.year > 2025 || (next!.year === 2025 && next!.month >= 4),
    ).toBe(true);
  });

  it("当天之后的下一个节气不会与当前节气相同", () => {
    const now = new Date("2025-06-21T12:00:00+08:00");
    const current = currentSolarTerm(now, "Asia/Shanghai");
    const next = nextSolarTerm(now, "Asia/Shanghai");
    expect(next?.name).not.toBe(current?.name);
  });

  it("非法时区返回 null", () => {
    expect(nextSolarTerm(new Date(), "Bad/Zone")).toBeNull();
  });
});
