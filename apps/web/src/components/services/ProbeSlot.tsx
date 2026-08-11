import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import { CheckCircle2, CircleAlert, CircleX, LoaderCircle } from "lucide-react";

import type { HttpProbeResponse } from "@homepage/domain";

import { fetchProbe, isApiClientError } from "@/lib/api";
import {
  formatPublicError,
  formatUnknownError,
} from "@/lib/format-error";
import { useGroupActive } from "@/hooks/group-active";
import { messages, probeStatusText } from "@/lib/messages";
import { cn } from "@/lib/utils";

/** HTTP 探测静默轮询间隔 */
export const PROBE_POLL_INTERVAL_MS = 30_000;

export type ProbeSlotProps = {
  probeId: string;
  className?: string;
  /**
   * 与 Docker 徽章并排时：可达态不画第二颗勾，只保留延迟数字。
   * 异常 / 不可达 / 错误仍显示图标。
   */
  suppressOkIcon?: boolean;
};

type SlotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: HttpProbeResponse };

function resolveErrorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    if (error.publicError) {
      return formatPublicError(error.publicError, messages.error.probe);
    }
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : messages.error.probe;
  }
  return formatUnknownError(error, messages.error.probe);
}

function StatusIcon({
  state,
}: {
  state: HttpProbeResponse["status"] | "loading" | "error";
}): JSX.Element {
  const className = "size-3.5 shrink-0";
  switch (state) {
    case "loading":
      return (
        <LoaderCircle
          className={cn(className, "animate-spin text-muted-foreground")}
          aria-hidden="true"
        />
      );
    case "reachable":
      return (
        <CheckCircle2
          className={cn(className, "text-emerald-600 dark:text-emerald-400")}
          aria-hidden="true"
        />
      );
    case "reachable_abnormal":
      return (
        <CircleAlert
          className={cn(className, "text-amber-600 dark:text-amber-400")}
          aria-hidden="true"
        />
      );
    case "unreachable":
    case "error":
      return (
        <CircleX
          className={cn(className, "text-destructive")}
          aria-hidden="true"
        />
      );
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function ProbeSlot({
  probeId,
  className,
  suppressOkIcon = false,
}: ProbeSlotProps): JSX.Element {
  const groupActive = useGroupActive();
  const [state, setState] = useState<SlotState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const hasSuccessRef = useRef(false);
  const pageVisibleRef = useRef(
    typeof document === "undefined"
      ? true
      : document.visibilityState !== "hidden",
  );
  const groupActiveRef = useRef(groupActive);
  const wasGroupActiveRef = useRef(groupActive);
  groupActiveRef.current = groupActive;

  const load = useCallback(
    async (signal: AbortSignal, options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent || !hasSuccessRef.current) {
        setState({ status: "loading" });
      }

      try {
        const data = await fetchProbe(probeId, { signal });
        if (signal.aborted) {
          return;
        }
        hasSuccessRef.current = true;
        setState({ status: "success", data });
      } catch (error) {
        if (signal.aborted) {
          return;
        }
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
        setState({ status: "error", message: resolveErrorMessage(error) });
      }
    },
    [probeId],
  );

  useEffect(() => {
    // probeId / 手动重试时清空成功态，避免沿用旧目标的 silent 短路
    hasSuccessRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    void load(controller.signal);

    let timerId: number | null = null;

    const isActive = (): boolean =>
      pageVisibleRef.current && groupActiveRef.current;

    const clearTimer = (): void => {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
    };

    const tick = (): void => {
      if (!isActive()) {
        return;
      }
      abortRef.current?.abort();
      const next = new AbortController();
      abortRef.current = next;
      void load(next.signal, { silent: true });
    };

    const startTimer = (): void => {
      clearTimer();
      timerId = window.setInterval(tick, PROBE_POLL_INTERVAL_MS);
    };

    const onVisibility = (): void => {
      const visible = document.visibilityState !== "hidden";
      pageVisibleRef.current = visible;
      if (visible) {
        if (groupActiveRef.current) {
          tick();
        }
        startTimer();
      } else {
        clearTimer();
      }
    };

    // 折叠时仍挂 timer，tick 内按 isActive 短路，避免展开后无轮询
    if (pageVisibleRef.current) {
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
  }, [load, reloadToken]);

  // 分组从折叠展开时补一次静默刷新（首载由主 effect 负责）
  useEffect(() => {
    const wasActive = wasGroupActiveRef.current;
    wasGroupActiveRef.current = groupActive;
    if (!groupActive || wasActive || !pageVisibleRef.current) {
      return;
    }
    abortRef.current?.abort();
    const next = new AbortController();
    abortRef.current = next;
    void load(next.signal, { silent: true });
  }, [groupActive, load]);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
    hasSuccessRef.current = false;
    setReloadToken((n) => n + 1);
  }, []);

  if (state.status === "loading") {
    const label = probeStatusText("loading");
    // 与 Docker 并排时：加载中也不再多一颗转圈，避免顶栏两个 spinner
    if (suppressOkIcon) {
      return (
        <div
          data-slot="probe-slot"
          data-state="loading"
          role="status"
          aria-label={label}
          className={cn(
            "inline-flex h-5 max-w-[5.5rem] items-center text-[11px] leading-none text-muted-foreground",
            className,
          )}
          title={label}
        >
          <span className="truncate tabular-nums">…</span>
        </div>
      );
    }
    return (
      <div
        data-slot="probe-slot"
        data-state="loading"
        role="status"
        aria-label={label}
        className={cn(
          "inline-flex size-5 items-center justify-center text-xs leading-none text-muted-foreground",
          className,
        )}
        title={label}
      >
        <StatusIcon state="loading" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        data-slot="probe-slot"
        data-state="error"
        role="status"
        aria-label={state.message}
        className={cn(
          "inline-flex max-w-[10rem] flex-wrap items-center gap-1.5 text-xs text-destructive",
          className,
        )}
      >
        <StatusIcon state="error" />
        <span className="truncate">{state.message}</span>
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={handleRetry}
        >
          {messages.common.retry}
        </button>
      </div>
    );
  }

  const data = state.data;
  const latencyMs =
    "latencyMs" in data && data.latencyMs !== undefined
      ? Math.round(data.latencyMs)
      : undefined;
  // 可达：图标 + 紧凑延迟；与 Docker 并排时可达态去掉第二颗勾
  let label: string;
  let ariaLabel: string;
  if (data.status === "unreachable") {
    label = probeStatusText("unreachable", data.reason);
    ariaLabel = label;
  } else {
    const statusLabel = probeStatusText(data.status);
    label = latencyMs !== undefined ? `${latencyMs}ms` : statusLabel;
    ariaLabel =
      latencyMs !== undefined ? `${statusLabel} ${latencyMs}ms` : statusLabel;
  }

  const hideOkIcon = suppressOkIcon && data.status === "reachable";

  return (
    <div
      data-slot="probe-slot"
      data-state={data.status}
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-5 max-w-[5.5rem] items-center text-[11px] leading-none text-muted-foreground",
        hideOkIcon ? "gap-0" : "gap-1",
        className,
      )}
      title={ariaLabel}
    >
      {hideOkIcon ? null : <StatusIcon state={data.status} />}
      <span className="truncate tabular-nums">{label}</span>
    </div>
  );
}
