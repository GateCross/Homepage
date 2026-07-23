import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import type { DockerStatusResponse } from "@homepage/domain";

import { fetchDockerBatch, isApiClientError } from "@/lib/api";
import {
  formatPublicError,
  formatUnknownError,
} from "@/lib/format-error";
import { messages } from "@/lib/messages";

/** 批量 Docker 状态轮询间隔（两阶段：轻量状态 + 含 stats 指标） */
export const DOCKER_BATCH_POLL_INTERVAL_MS = 15_000;

export function dockerTargetKey(server: string, container: string): string {
  return `${server}\0${container}`;
}

export type DockerEntryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: DockerStatusResponse };

type DockerStatusMap = Map<string, DockerEntryState>;

const GLOBAL_ERROR_KEY = "\0";

export type DockerStatusStoreValue = {
  get: (server: string, container: string) => DockerEntryState;
  refresh: (options?: { silent?: boolean }) => void;
  /** 配置编辑器打开时暂停轮询，避免占满连接 */
  setPaused: (paused: boolean) => void;
  paused: boolean;
};

const DockerStatusContext = createContext<DockerStatusStoreValue | null>(null);

function resolveErrorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    if (error.publicError) {
      return formatPublicError(error.publicError, messages.error.docker);
    }
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : messages.error.docker;
  }
  return formatUnknownError(error, messages.error.docker);
}

function hasResourceMetrics(data: DockerStatusResponse): boolean {
  if (data.status !== "running") return false;
  return data.cpuPercent !== undefined || data.memoryPercent !== undefined;
}

/**
 * 合并 lite（状态）与 full（含 stats）：
 * - 新结果优先覆盖状态字段
 * - full 失败时不抹掉已有徽章
 * - lite 覆盖 full 时保留已有 metrics（避免轮询轻量阶段闪一下指标）
 */
function mergeDockerMaps(
  prev: DockerStatusMap,
  incoming: DockerStatusMap,
  mode: "lite" | "full",
): DockerStatusMap {
  const next = new Map(prev);
  next.delete(GLOBAL_ERROR_KEY);

  for (const [key, entry] of incoming) {
    if (entry.status !== "success") {
      next.set(key, entry);
      continue;
    }

    const prevEntry = prev.get(key);
    if (
      mode === "lite" &&
      prevEntry?.status === "success" &&
      prevEntry.data.status === "running" &&
      entry.data.status === "running" &&
      hasResourceMetrics(prevEntry.data) &&
      !hasResourceMetrics(entry.data)
    ) {
      next.set(key, {
        status: "success",
        data: {
          ...entry.data,
          ...(prevEntry.data.cpuPercent !== undefined
            ? { cpuPercent: prevEntry.data.cpuPercent }
            : {}),
          ...(prevEntry.data.memoryPercent !== undefined
            ? { memoryPercent: prevEntry.data.memoryPercent }
            : {}),
          ...(prevEntry.data.memoryUsageBytes !== undefined
            ? { memoryUsageBytes: prevEntry.data.memoryUsageBytes }
            : {}),
          ...(prevEntry.data.memoryLimitBytes !== undefined
            ? { memoryLimitBytes: prevEntry.data.memoryLimitBytes }
            : {}),
        },
      });
      continue;
    }

    next.set(key, entry);
  }
  return next;
}

function mapFromBatch(
  results: ReadonlyArray<{
    server: string;
    container: string;
    result: DockerStatusResponse;
  }>,
): DockerStatusMap {
  const next: DockerStatusMap = new Map();
  for (const item of results) {
    next.set(dockerTargetKey(item.server, item.container), {
      status: "success",
      data: item.result,
    });
  }
  return next;
}

export type DockerStatusProviderProps = {
  children: ReactNode;
  enabled?: boolean;
  pollIntervalMs?: number;
};

export function DockerStatusProvider({
  children,
  enabled = true,
  pollIntervalMs = DOCKER_BATCH_POLL_INTERVAL_MS,
}: DockerStatusProviderProps): JSX.Element {
  const [map, setMap] = useState<DockerStatusMap>(() => new Map());
  const [paused, setPausedState] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const hasSuccessRef = useRef(false);
  const pausedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const generationRef = useRef(0);
  const visibleRef = useRef(
    typeof document === "undefined"
      ? true
      : document.visibilityState !== "hidden",
  );

  enabledRef.current = enabled;

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPausedState(next);
  }, []);

  /**
   * 两阶段加载：
   * 1) lite（?stats=0）→ 尽快出徽章
   * 2) full（含 stats）→ 补 CPU/内存；失败且 silent 时保留 lite 状态
   */
  const load = useCallback(
    async (signal: AbortSignal, options?: { silent?: boolean }) => {
      if (!enabledRef.current) return;
      const silent = options?.silent === true;
      const generation = ++generationRef.current;

      const stillCurrent = (): boolean =>
        !signal.aborted && generation === generationRef.current;

      try {
        // —— 阶段 1：轻量状态 ——
        const liteBody = await fetchDockerBatch({
          signal,
          includeStats: false,
        });
        if (!stillCurrent()) return;

        const liteMap = mapFromBatch(liteBody.results);
        hasSuccessRef.current = true;
        setMap((prev) => mergeDockerMaps(prev, liteMap, "lite"));

        // —— 阶段 2：含 stats ——
        try {
          const fullBody = await fetchDockerBatch({
            signal,
            includeStats: true,
          });
          if (!stillCurrent()) return;
          const fullMap = mapFromBatch(fullBody.results);
          setMap((prev) => mergeDockerMaps(prev, fullMap, "full"));
        } catch (statsError) {
          if (!stillCurrent()) return;
          if (
            (statsError instanceof DOMException &&
              statsError.name === "AbortError") ||
            (statsError instanceof Error && statsError.name === "AbortError")
          ) {
            return;
          }
          // lite 已成功：指标失败不拖垮徽章
          if (hasSuccessRef.current) return;
          throw statsError;
        }
      } catch (error) {
        if (!stillCurrent()) return;
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return;
        }
        if (silent && hasSuccessRef.current) {
          return;
        }
        hasSuccessRef.current = false;
        const message = resolveErrorMessage(error);
        setMap(new Map([[GLOBAL_ERROR_KEY, { status: "error", message }]]));
      }
    },
    [],
  );

  const refresh = useCallback(
    (options?: { silent?: boolean }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void load(controller.signal, options);
    },
    [load],
  );

  // 主加载 + 轮询
  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      generationRef.current += 1;
      hasSuccessRef.current = false;
      setMap(new Map());
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    void load(controller.signal);

    let timerId: number | null = null;
    const clearTimer = (): void => {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
    };

    const tick = (): void => {
      if (!visibleRef.current || pausedRef.current) return;
      abortRef.current?.abort();
      const next = new AbortController();
      abortRef.current = next;
      void load(next.signal, { silent: true });
    };

    const startTimer = (): void => {
      clearTimer();
      timerId = window.setInterval(tick, pollIntervalMs);
    };

    const onVisibility = (): void => {
      const visible = document.visibilityState !== "hidden";
      visibleRef.current = visible;
      if (visible && !pausedRef.current) {
        tick();
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
      controller.abort();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled, load, pollIntervalMs]);

  // 从暂停恢复时立即补拉
  useEffect(() => {
    if (!enabled || paused) return;
    if (!visibleRef.current) return;
    abortRef.current?.abort();
    const next = new AbortController();
    abortRef.current = next;
    void load(next.signal, { silent: true });
  }, [paused, enabled, load]);

  const get = useCallback(
    (server: string, container: string): DockerEntryState => {
      const hit = map.get(dockerTargetKey(server, container));
      if (hit) return hit;
      const globalErr = map.get(GLOBAL_ERROR_KEY);
      if (globalErr && globalErr.status === "error") return globalErr;
      if (!hasSuccessRef.current) return { status: "loading" };
      return { status: "error", message: "未返回该容器状态" };
    },
    [map],
  );

  const value = useMemo<DockerStatusStoreValue>(
    () => ({
      get,
      refresh,
      setPaused,
      paused,
    }),
    [get, refresh, setPaused, paused],
  );

  return (
    <DockerStatusContext.Provider value={value}>
      {children}
    </DockerStatusContext.Provider>
  );
}

export function useDockerStatusStore(): DockerStatusStoreValue {
  const ctx = useContext(DockerStatusContext);
  if (ctx === null) {
    throw new Error("useDockerStatusStore 必须在 DockerStatusProvider 内使用");
  }
  return ctx;
}

/** 无 Provider 时返回 null（供 DockerSlot 降级） */
export function useOptionalDockerStatusStore(): DockerStatusStoreValue | null {
  return useContext(DockerStatusContext);
}

export function useDockerStatusEntry(
  server: string,
  container: string,
): DockerEntryState {
  const ctx = useContext(DockerStatusContext);
  if (ctx === null) {
    return { status: "loading" };
  }
  return ctx.get(server, container);
}
