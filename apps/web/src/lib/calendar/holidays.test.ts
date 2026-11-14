/**
 * 法定节日倒计时：固定公历日、农历反推、节气三类锚点，
 * 以及跨年取明年的行为。
 */
import { describe, expect, it } from "vitest";

import { nextStatutoryHolidayCountdown } from "./holidays";

describe("nextStatutoryHolidayCountdown 固定公历节日", () => {
  it("元旦当日倒计时为 0", () => {
    const result = nextStatutoryHolidayCountdown(
      new Date("2025-01-01T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(result?.holiday.name).toBe("元旦");
    expect(result?.daysUntil).toBe(0);
  });

  it("劳动节与国庆按固定月日", () => {
    const labor = nextStatutoryHolidayCountdown(
      new Date("2025-04-20T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(labor?.holiday.name).toBe("劳动节");

    const national = nextStatutoryHolidayCountdown(
      new Date("2025-09-20T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(national?.holiday.name).toBe("国庆");
  });
});

describe("nextStatutoryHolidayCountdown 农历节日", () => {
  it("春节按农历正月初一反推", () => {
    // 2025 春节为 1 月 29 日
    const result = nextStatutoryHolidayCountdown(
      new Date("2025-01-20T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(result?.holiday.name).toBe("春节");
    expect(result?.holiday.month).toBe(1);
    expect(result?.holiday.day).toBe(29);
    expect(result?.daysUntil).toBe(9);
  });

  it("端午跟随农历，不固定公历日", () => {
    // 2025 端午为 5 月 31 日，与固定 5-01 的劳动节不同日
    const result = nextStatutoryHolidayCountdown(
      new Date("2025-05-20T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(result?.holiday.name).toBe("端午");
    expect(result?.holiday.month).toBe(5);
    expect(result?.holiday.day).toBe(31);
  });

  it("中秋晚于国庆时，国庆先到", () => {
    // 2025 中秋 10-06 晚于国庆 10-01，故 9 月下旬的下一节是国庆
    const result = nextStatutoryHolidayCountdown(
      new Date("2025-09-20T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(result?.holiday.name).toBe("国庆");
  });

  it("闰月不算节日：闰六月的同名月日不参与命中", () => {
    // 2025 有闰六月；中秋稳定落在八月十五即 10-06，不因闰月提前
    const afterNational = nextStatutoryHolidayCountdown(
      new Date("2025-10-02T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(afterNational?.holiday.name).toBe("中秋");
    expect(afterNational?.holiday.month).toBe(10);
    expect(afterNational?.holiday.day).toBe(6);
  });
});

describe("nextStatutoryHolidayCountdown 节气节日", () => {
  it("清明取当年节气交节日", () => {
    const result = nextStatutoryHolidayCountdown(
      new Date("2025-03-25T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(result?.holiday.name).toBe("清明");
    expect(result?.holiday.id).toBe("qingming");
    expect(result?.holiday.month).toBe(4);
  });
});

describe("nextStatutoryHolidayCountdown 跨年与倒计时", () => {
  it("年末最后一个节庆之后取次年元旦", () => {
    const result = nextStatutoryHolidayCountdown(
      new Date("2025-12-25T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(result?.holiday.name).toBe("元旦");
    expect(result?.holiday.year).toBe(2026);
    expect(result?.daysUntil).toBeGreaterThan(0);
  });

  it("daysUntil 与实际日差一致", () => {
    const now = new Date("2025-09-25T12:00:00+08:00");
    const result = nextStatutoryHolidayCountdown(now, "Asia/Shanghai");
    expect(result).not.toBeNull();
    const target = Date.UTC(
      result!.holiday.year,
      result!.holiday.month - 1,
      result!.holiday.day,
    );
    // 上海时间 12:00 对应 UTC 04:00，落在同一日历日
    const today = Date.UTC(2025, 8, 25);
    expect(result!.daysUntil).toBe(Math.round((target - today) / 86_400_000));
  });

  it("倒计时永不为负", () => {
    for (const iso of [
      "2025-01-01T00:00:00+08:00",
      "2025-06-15T23:59:59+08:00",
      "2025-12-31T23:59:59+08:00",
    ]) {
      const result = nextStatutoryHolidayCountdown(
        new Date(iso),
        "Asia/Shanghai",
      );
      expect(result?.daysUntil).toBeGreaterThanOrEqual(0);
    }
  });

  it("label 含节日名", () => {
    const result = nextStatutoryHolidayCountdown(
      new Date("2025-01-01T12:00:00+08:00"),
      "Asia/Shanghai",
    );
    expect(result?.label).toContain("元旦");
  });
});
