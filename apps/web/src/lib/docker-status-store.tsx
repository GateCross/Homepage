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

/** 批量 Docker 状态轮询间隔（仅 1 条 HTTP，与旧单卡间隔同量级） */
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

  const load = useCallback(
    async (signal: AbortSignal, options?: { silent?: boolean }) => {
      if (!enabledRef.current) return;
      const silent = options?.silent === true;

      try {
        const body = await fetchDockerBatch({ signal });
        if (signal.aborted) return;
        const next: DockerStatusMap = new Map();
        for (const item of body.results) {
          next.set(dockerTargetKey(item.server, item.container), {
            status: "success",
            data: item.result,
          });
        }
        hasSuccessRef.current = true;
        setMap(next);
      } catch (error) {
        if (signal.aborted) return;
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
