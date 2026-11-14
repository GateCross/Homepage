import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVisibilityPolling } from "./use-visibility-poll";

// 改写 jsdom 的可见性状态并广播事件。
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

// 闭包计数器：引用保持稳定，记录 tick 调用次数。
function createCounter(): { count: () => number; tick: () => void } {
  let count = 0;
  return {
    count: () => count,
    tick: () => {
      count += 1;
    },
  };
}

describe("useVisibilityPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("可见时按间隔触发 tick，隐藏后停止，恢复可见立即补拉一次", () => {
    const counter = createCounter();
    const { rerender } = renderHook(
      ({ paused }) =>
        useVisibilityPolling({
          enabled: true,
          paused,
          intervalMs: 1000,
          tick: counter.tick,
        }),
      { initialProps: { paused: false } },
    );

    vi.advanceTimersByTime(1000);
    expect(counter.count()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(counter.count()).toBe(2);

    setVisibility("hidden");
    vi.advanceTimersByTime(5000);
    expect(counter.count()).toBe(2);

    setVisibility("visible");
    expect(counter.count()).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(counter.count()).toBe(4);

    rerender({ paused: true });
    vi.advanceTimersByTime(5000);
    expect(counter.count()).toBe(4);
  });

  it("首次挂载不补拉，暂停恢复时立即补拉一次", () => {
    const counter = createCounter();
    const { rerender } = renderHook(
      ({ paused }) =>
        useVisibilityPolling({
          enabled: true,
          paused,
          intervalMs: null,
          tick: counter.tick,
        }),
      { initialProps: { paused: true } },
    );

    expect(counter.count()).toBe(0);

    rerender({ paused: false });
    expect(counter.count()).toBe(1);

    rerender({ paused: true });
    rerender({ paused: false });
    expect(counter.count()).toBe(2);
  });
});
