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

import { useVisibilityPolling } from "@/hooks/use-visibility-poll";
import {
  dockerTargetKey,
  GLOBAL_ERROR_KEY,
  mapFromBatch,
  mergeDockerMaps,
  type DockerEntryState,
  type DockerStatusMap,
} from "@/lib/pure/docker-merge";
import { fetchDockerBatch } from "@/lib/api";
import { resolveErrorMessage } from "@/lib/format-error";
import { messages } from "@/lib/messages";

/** 批量 Docker 状态轮询间隔（两阶段：轻量状态 + 含 stats 指标） */
const DOCKER_BATCH_POLL_INTERVAL_MS = 15_000;

export type { DockerEntryState };

export type DockerStatusStoreValue = {
  get: (server: string, container: string) => DockerEntryState;
  refresh: (options?: { silent?: boolean }) => void;
  /** 配置编辑器打开时暂停轮询，避免占满连接 */
  setPaused: (paused: boolean) => void;
  paused: boolean;
};

const DockerStatusContext = createContext<DockerStatusStoreValue | null>(null);

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
  const enabledRef = useRef(enabled);
  const generationRef = useRef(0);

  enabledRef.current = enabled;

  const setPaused = useCallback((next: boolean) => {
    setPausedState(next);
  }, []);

  /**
   * 两阶段加载：
   * 1) lite（?stats=0）→ 尽快出徽章；服务端随后后台预热 full
   * 2) 立即 full → 与预热 inflight 去重，running 只补 stats；失败不拖垮徽章
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

        // —— 阶段 2：指标（服务端已启动预热，可复用 lite + 只拉 stats）——
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
        const message = resolveErrorMessage(error, messages.error.docker);
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

  // 主加载：enabled 关闭时清空状态并停止
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
    return () => {
      controller.abort();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [enabled, load]);

  // 到点或恢复可见时的静默刷新：中止在途请求后重发
  const pollTick = useCallback(() => {
    abortRef.current?.abort();
    const next = new AbortController();
    abortRef.current = next;
    void load(next.signal, { silent: true });
  }, [load]);

  useVisibilityPolling({
    enabled,
    paused,
    intervalMs: pollIntervalMs,
    tick: pollTick,
  });

  const get = useCallback(
    (server: string, container: string): DockerEntryState => {
      const hit = map.get(dockerTargetKey(server, container));
      if (hit) return hit;
      const globalErr = map.get(GLOBAL_ERROR_KEY);
      if (globalErr?.status === "error") return globalErr;
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
