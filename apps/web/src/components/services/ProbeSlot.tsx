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
import { useGroupActive } from "@/lib/group-active";
import { messages, probeStatusText } from "@/lib/messages";
import { cn } from "@/lib/utils";

/** HTTP 探测静默轮询间隔 */
export const PROBE_POLL_INTERVAL_MS = 30_000;

export type ProbeSlotProps = {
  probeId: string;
  className?: string;
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

export function ProbeSlot({ probeId, className }: ProbeSlotProps): JSX.Element {
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
    return (
      <div
        data-slot="probe-slot"
        data-state="loading"
        role="status"
        aria-label={label}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
          className,
        )}
      >
        <StatusIcon state="loading" />
        <span>{label}</span>
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

  // 可达类状态只展示延迟；不可达才显示状态文案
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

  return (
    <div
      data-slot="probe-slot"
      data-state={data.status}
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-5 items-center gap-1.5 text-xs leading-none text-muted-foreground",
        className,
      )}
    >
      <StatusIcon state={data.status} />
      <span className="truncate tabular-nums">{label}</span>
    </div>
  );
}
