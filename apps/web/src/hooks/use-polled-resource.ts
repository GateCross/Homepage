import { useCallback, useEffect, useRef, useState } from "react";

import { useVisibilityPolling } from "@/hooks/use-visibility-poll";

export type PolledResourceOptions<T> = {
  /** 拉取一次数据；收到 abort 时应尽快放弃 */
  load: (signal: AbortSignal) => Promise<T>;
  /** 轮询间隔毫秒；null 表示不轮询，只在挂载与手动刷新时拉取 */
  intervalMs: number | null;
  /** 是否启用；false 时清空结果并停止轮询 */
  enabled?: boolean;
  /** 暂停轮询（数据保留）；恢复时会立即补拉一次 */
  paused?: boolean;
  /** 首次加载失败时的兜底文案 */
  fallbackMessage: string;
  /** 把错误转成可展示文案，通常传 resolveErrorMessage 的偏应用 */
  resolveError: (error: unknown) => string;
}

export type PolledResourceState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: T; fetchedAt: number };

export type PolledResourceResult<T> = {
  state: PolledResourceState<T>;
  /** 手动重试：清空已成功标记并立即重新拉取 */
  retry: () => void;
  /** 立即刷新一次；silent 为 true 时不闪 loading */
  refresh: (options?: { silent?: boolean }) => void;
};

/** 判断是否为中止错误；兼容 DOMException 与普通 Error 两种抛出形态 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 轮询式资源读取的统一骨架。
 *
 * 收敛中止控制、静默刷新不闪 loading、失败时保留上一次成功数据、卸载后不 setState；
 * 计时与页面可见性交给 useVisibilityPolling。
 */
export function usePolledResource<T>(
  options: PolledResourceOptions<T>,
): PolledResourceResult<T> {
  const {
    load,
    intervalMs,
    enabled = true,
    paused = false,
    fallbackMessage,
    resolveError,
  } = options;

  const [state, setState] = useState<PolledResourceState<T>>({
    status: "loading",
  });
  const [reloadToken, setReloadToken] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const hasSuccessRef = useRef(false);
  const generationRef = useRef(0);
  /** 最新一次成功数据的时间戳，供陈旧提示使用 */
  const fetchedAtRef = useRef(0);

  /** 执行一次拉取；silent 时不重置为 loading */
  const run = useCallback(
    async (signal: AbortSignal, silent: boolean): Promise<void> => {
      const generation = ++generationRef.current;
      const stillCurrent = (): boolean =>
        !signal.aborted && generation === generationRef.current;

      if (!silent || !hasSuccessRef.current) {
        setState({ status: "loading" });
      }

      try {
        const data = await load(signal);
        if (!stillCurrent()) return;
        hasSuccessRef.current = true;
        fetchedAtRef.current = Date.now();
        setState({ status: "success", data, fetchedAt: fetchedAtRef.current });
      } catch (error) {
        if (!stillCurrent() || isAbortError(error)) return;
        // 静默刷新失败保留上一次成功数据，避免卡片闪错
        if (silent && hasSuccessRef.current) return;
        hasSuccessRef.current = false;
        const message = resolveError(error) || fallbackMessage;
        setState({ status: "error", message });
      }
    },
    [fallbackMessage, load, resolveError],
  );

  /** 中止在途请求后发起新请求 */
  const start = useCallback(
    (options?: { silent?: boolean }): void => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void run(controller.signal, options?.silent === true);
    },
    [run],
  );

  const refresh = useCallback(
    (options?: { silent?: boolean }) => {
      start(options);
    },
    [start],
  );

  const retry = useCallback(() => {
    abortRef.current?.abort();
    hasSuccessRef.current = false;
    setReloadToken((n) => n + 1);
  }, []);

  // 主加载：enabled 关闭时清空状态并停止
  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      generationRef.current += 1;
      hasSuccessRef.current = false;
      setState({ status: "loading" });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    void run(controller.signal, false);
    return () => {
      controller.abort();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled, reloadToken, run, start]);

  const pollTick = useCallback(() => {
    start({ silent: true });
  }, [start]);

  useVisibilityPolling({ enabled, paused, intervalMs, tick: pollTick });

  return { state, retry, refresh };
}
