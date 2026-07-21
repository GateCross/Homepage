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
import { messages, probeStatusText } from "@/lib/messages";
import { cn } from "@/lib/utils";

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
  const [state, setState] = useState<SlotState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading" });

    void (async () => {
      try {
        const data = await fetchProbe(probeId, { signal: controller.signal });
        if (controller.signal.aborted) {
          return;
        }
        setState({ status: "success", data });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return;
        }
        setState({ status: "error", message: resolveErrorMessage(error) });
      }
    })();

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [probeId, reloadToken]);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
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
          "inline-flex flex-wrap items-center gap-1.5 text-xs text-destructive",
          className,
        )}
      >
        <StatusIcon state="error" />
        <span>{state.message}</span>
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
