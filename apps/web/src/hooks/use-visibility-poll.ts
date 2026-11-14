import { useEffect, useRef } from "react";

/** 页面是否可见；SSR 环境下按可见处理 */
export function isPageVisible(): boolean {
  return typeof document === "undefined"
    ? true
    : document.visibilityState !== "hidden";
}

export type VisibilityPollingOptions = {
  /** 是否启用；false 时停表不轮询 */
  enabled: boolean;
  /** 暂停轮询（数据保留）；取消暂停时立即补拉一次 */
  paused: boolean;
  /** 轮询间隔毫秒；null 表示不轮询 */
  intervalMs: number | null;
  /** 到点或恢复可见时执行；须为稳定引用（useCallback） */
  tick: () => void;
};

/**
 * 页面可见性轮询的统一骨架：
 * 页面隐藏时停表、恢复可见立即补拉一次并重启计时、暂停时到点不执行、
 * 暂停恢复时立即补拉一次（首次挂载跳过，避免与主加载重复请求）。
 */
export function useVisibilityPolling(
  options: VisibilityPollingOptions,
): void {
  const { enabled, paused, intervalMs, tick } = options;

  const visibleRef = useRef(isPageVisible());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!enabled) return;

    let timerId: number | null = null;
    const clearTimer = (): void => {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
    };

    const guardedTick = (): void => {
      if (!visibleRef.current || pausedRef.current) return;
      tick();
    };

    const startTimer = (): void => {
      clearTimer();
      if (intervalMs === null) return;
      timerId = window.setInterval(guardedTick, intervalMs);
    };

    const onVisibility = (): void => {
      const visible = isPageVisible();
      visibleRef.current = visible;
      if (visible && !pausedRef.current) {
        guardedTick();
        startTimer();
      } else {
        clearTimer();
      }
    };

    if (visibleRef.current && !pausedRef.current) {
      startTimer();
    }

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, tick]);

  // 从暂停恢复时立即补拉。首次挂载跳过，避免与主加载重复请求
  const pausedSettledRef = useRef(false);
  useEffect(() => {
    if (!pausedSettledRef.current) {
      pausedSettledRef.current = true;
      return;
    }
    if (!enabled || paused || !visibleRef.current) return;
    tick();
  }, [enabled, paused, tick]);
}
