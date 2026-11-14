import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as holidays from "@/lib/calendar/holidays";
import * as lunar from "@/lib/calendar/lunar";
import * as shichen from "@/lib/calendar/shichen";
import * as solarTerms from "@/lib/calendar/solar-terms";

import { DateTimeWidget } from "./DateTimeWidget";

/** 每个历法函数的调用次数，用于断言「每秒重算」已修掉 */
function countCalendarCalls(): {
  lunar: number;
  current: number;
  next: number;
  holiday: number;
  shichen: number;
} {
  return {
    lunar: vi.mocked(lunar.lunarFromDate).mock.calls.length,
    current: vi.mocked(solarTerms.currentSolarTerm).mock.calls.length,
    next: vi.mocked(solarTerms.nextSolarTerm).mock.calls.length,
    holiday: vi.mocked(holidays.nextStatutoryHolidayCountdown).mock.calls.length,
    shichen: vi.mocked(shichen.shichenFromDate).mock.calls.length,
  };
}

describe("DateTimeWidget 历法分桶", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T02:00:00Z"));
    // 五个历法函数一律 spy，保证计数读取不依赖各用例是否单独声明
    vi.spyOn(lunar, "lunarFromDate");
    vi.spyOn(solarTerms, "currentSolarTerm");
    vi.spyOn(solarTerms, "nextSolarTerm");
    vi.spyOn(holidays, "nextStatutoryHolidayCountdown");
    vi.spyOn(shichen, "shichenFromDate");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("同一天内每秒走时，历法函数不重复计算", () => {
    render(<DateTimeWidget options={{ timezone: "Asia/Shanghai" }} />);

    const afterMount = countCalendarCalls();
    // 挂载即算一次，四个历法项各一次
    expect(afterMount.lunar).toBe(1);
    expect(afterMount.current).toBe(1);
    expect(afterMount.next).toBe(1);
    expect(afterMount.holiday).toBe(1);

    // 走 5 个整秒，仍停在同一日历日
    act(() => { vi.advanceTimersByTime(5_000); });

    const afterTicks = countCalendarCalls();
    expect(afterTicks.lunar).toBe(1);
    expect(afterTicks.current).toBe(1);
    expect(afterTicks.next).toBe(1);
    expect(afterTicks.holiday).toBe(1);
  });

  it("时辰跨越整点桶时只重算时辰，不动按日的历法", () => {
    // 上海时间 09:59:59，两秒后进 10 点桶
    vi.setSystemTime(new Date("2026-11-13T01:59:59Z"));
    render(<DateTimeWidget options={{ timezone: "Asia/Shanghai" }} />);

    const afterMount = countCalendarCalls();
    expect(afterMount.lunar).toBe(1);
    expect(afterMount.shichen).toBe(1);

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(countCalendarCalls().lunar).toBe(1);
    expect(countCalendarCalls().shichen).toBe(2);
  });

  it("跨日界时按日的历法重算一次", () => {
    // 上海时间 23:59:59，两秒后跨到次日
    vi.setSystemTime(new Date("2026-11-13T15:59:59Z"));
    render(<DateTimeWidget options={{ timezone: "Asia/Shanghai" }} />);

    expect(countCalendarCalls().lunar).toBe(1);

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(countCalendarCalls().lunar).toBe(2);
  });
});
