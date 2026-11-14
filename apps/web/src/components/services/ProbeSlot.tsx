import { useCallback, type JSX } from "react";
import { CheckCircle2, CircleAlert, CircleX, LoaderCircle } from "lucide-react";

import type { HttpProbeResponse } from "@/lib/contracts";

import { fetchProbe } from "@/lib/api";
import { resolveErrorMessage } from "@/lib/format-error";
import { useGroupActive } from "@/hooks/use-group-active";
import { usePolledResource } from "@/hooks/use-polled-resource";
import { messages, probeStatusText } from "@/lib/messages";
import { cn } from "@/lib/utils";

/** HTTP 探测静默轮询间隔 */
const PROBE_POLL_INTERVAL_MS = 30_000;

export type ProbeSlotProps = {
  probeId: string;
  className?: string;
  /**
   * 与 Docker 徽章并排时：可达态不画第二颗勾，只保留延迟数字。
   * 异常 / 不可达 / 错误仍显示图标。
   */
  suppressOkIcon?: boolean;
};

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
        <CircleX className={cn(className, "text-destructive")} aria-hidden="true" />
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

  const load = useCallback(
    (signal: AbortSignal) => fetchProbe(probeId, { signal }),
    [probeId],
  );
  const resolveError = useCallback(
    (error: unknown) => resolveErrorMessage(error, messages.error.probe),
    [],
  );

  const { state, retry } = usePolledResource<HttpProbeResponse>({
    load,
    resolveError,
    fallbackMessage: messages.error.probe,
    intervalMs: PROBE_POLL_INTERVAL_MS,
    // 分组折叠时不轮询；展开时由 hook 的 paused 恢复逻辑补拉
    paused: !groupActive,
  });

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
          onClick={retry}
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
    return (
      <div
        data-slot="probe-slot"
        data-state={data.status}
        role="status"
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-5 max-w-[7rem] items-center gap-1 text-[11px] leading-none text-destructive",
          className,
        )}
        title={label}
      >
        <StatusIcon state={data.status} />
        <span className="truncate">{label}</span>
      </div>
    );
  }

  const statusLabel = probeStatusText(data.status);
  label = latencyMs !== undefined ? `${latencyMs}ms` : statusLabel;
  ariaLabel = latencyMs !== undefined ? `${statusLabel} ${latencyMs}ms` : statusLabel;
  const hideOkIcon = suppressOkIcon && data.status === "reachable";

  return (
    <div
      data-slot="probe-slot"
      data-state={data.status}
      role="status"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-5 max-w-[5.5rem] items-center gap-1 text-[11px] leading-none text-muted-foreground",
        className,
      )}
      title={ariaLabel}
    >
      {hideOkIcon ? null : <StatusIcon state={data.status} />}
      <span className="truncate tabular-nums">{label}</span>
    </div>
  );
}
