/**
 * 农历换算的已知基准点。
 * 期望值取自香港天文台公开历表，用于防止数据表或换算逻辑被改坏。
 */
import { describe, expect, it } from "vitest";

import { lunarFromDate, solarToLunar } from "./lunar";

describe("solarToLunar 已知基准点", () => {
  it("2025 春节为腊月三十之后的正月初一（2025-01-29）", () => {
    const lunar = solarToLunar(2025, 1, 29);
    expect(lunar).not.toBeNull();
    expect(lunar?.month).toBe(1);
    expect(lunar?.day).toBe(1);
    expect(lunar?.isLeap).toBe(false);
    expect(lunar?.text).toBe("正月初一");
  });

  it("2024 春节为 2024-02-10 正月初一", () => {
    const lunar = solarToLunar(2024, 2, 10);
    expect(lunar?.month).toBe(1);
    expect(lunar?.day).toBe(1);
    expect(lunar?.isLeap).toBe(false);
  });

  it("2025 中秋为八月十五（2025-10-06）", () => {
    const lunar = solarToLunar(2025, 10, 6);
    expect(lunar?.month).toBe(8);
    expect(lunar?.day).toBe(15);
  });

  it("2025 端午为五月初五（2025-05-31）", () => {
    const lunar = solarToLunar(2025, 5, 31);
    expect(lunar?.month).toBe(5);
    expect(lunar?.day).toBe(5);
  });

  it("2025 闰六月存在，闰月标记正确", () => {
    // 2025 农历闰六月：2025-07-25 起为闰六月初一
    const leap = solarToLunar(2025, 7, 25);
    expect(leap?.month).toBe(6);
    expect(leap?.isLeap).toBe(true);
    expect(leap?.text).toContain("闰六月");
  });

  it("干支与生肖随农历年切换，不随公历年", () => {
    // 2025-01-28 仍在甲辰龙年，次日进入乙巳蛇年
    const before = solarToLunar(2025, 1, 28);
    const after = solarToLunar(2025, 1, 29);
    expect(before?.animal).toBe("龙");
    expect(after?.animal).toBe("蛇");
    expect(before?.yearGanZhi).not.toBe(after?.yearGanZhi);
  });
});

describe("solarToLunar 边界", () => {
  it("下界之前返回 null", () => {
    expect(solarToLunar(1900, 1, 30)).toBeNull();
  });

  it("上界之后返回 null", () => {
    expect(solarToLunar(2101, 1, 1)).toBeNull();
  });

  it("非法月日返回 null", () => {
    expect(solarToLunar(2025, 13, 1)).toBeNull();
    expect(solarToLunar(2025, 2, 30)).toBeNull();
  });
});

describe("lunarFromDate 时区处理", () => {
  it("同一时刻在不同时区可能落在不同农历日", () => {
    // UTC 2025-01-28 20:00 = 上海 2025-01-29 04:00，上海已是正月初一
    const instant = new Date(Date.UTC(2025, 0, 28, 20, 0, 0));
    const shanghai = lunarFromDate(instant, "Asia/Shanghai");
    const utc = lunarFromDate(instant, "UTC");
    expect(shanghai?.text).toBe("正月初一");
    expect(utc?.text).not.toBe("正月初一");
  });

  it("非法时区返回 null 而不抛错", () => {
    expect(lunarFromDate(new Date(), "Not/AZone")).toBeNull();
  });

  it("文本字段自洽：text 由 monthText 与 dayText 拼接", () => {
    const lunar = lunarFromDate(new Date(Date.UTC(2025, 9, 6, 4)), "Asia/Shanghai");
    expect(lunar).not.toBeNull();
    expect(lunar?.text).toBe(`${lunar?.monthText}${lunar?.dayText}`);
  });
});
