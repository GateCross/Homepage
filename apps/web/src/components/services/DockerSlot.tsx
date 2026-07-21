import { useCallback, type JSX } from "react";
import {
  CheckCircle2,
  CircleMinus,
  CirclePause,
  CircleX,
  HeartPulse,
  LoaderCircle,
  RotateCw,
} from "lucide-react";

import type { DockerHealth, DockerStatusResponse } from "@homepage/domain";

import {
  DOCKER_BATCH_POLL_INTERVAL_MS,
  useDockerStatusEntry,
  useOptionalDockerStatusStore,
} from "@/lib/docker-status-store";
import { dockerStatusText, messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

/** @deprecated 使用批量轮询间隔；保留导出名以免外部引用断裂 */
export const DOCKER_POLL_INTERVAL_MS = DOCKER_BATCH_POLL_INTERVAL_MS;

export type DockerSlotMode = "full" | "badge" | "metrics";

export type DockerSlotProps = {
  server: string;
  container: string;
  /** badge：仅状态徽章（右上角）；metrics：仅资源条；full：完整展示 */
  mode?: DockerSlotMode;
  className?: string;
};

type UiState =
  | DockerStatusResponse["status"]
  | "loading"
  | "error"
  | "unhealthy";

function StatusIcon({ state }: { state: UiState }): JSX.Element {
  const className = "size-3.5 shrink-0";
  switch (state) {
    case "loading":
    case "starting":
      return (
        <LoaderCircle
          className={cn(className, "animate-spin text-sky-600 dark:text-sky-400")}
          aria-hidden="true"
        />
      );
    case "restarting":
      return (
        <RotateCw
          className={cn(
            className,
            "animate-spin text-amber-600 dark:text-amber-400",
          )}
          aria-hidden="true"
        />
      );
    case "running":
      return (
        <CheckCircle2
          className={cn(className, "text-emerald-600 dark:text-emerald-400")}
          aria-hidden="true"
        />
      );
    case "unhealthy":
      return (
        <HeartPulse
          className={cn(className, "text-rose-600 dark:text-rose-400")}
          aria-hidden="true"
        />
      );
    case "paused":
      return (
        <CirclePause
          className={cn(className, "text-amber-600 dark:text-amber-400")}
          aria-hidden="true"
        />
      );
    case "stopped":
      return (
        <CircleMinus
          className={cn(className, "text-amber-600 dark:text-amber-400")}
          aria-hidden="true"
        />
      );
    case "unavailable":
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

function resolveUiState(
  status: DockerStatusResponse["status"],
  health: DockerHealth | undefined,
): UiState {
  if (status === "running" && health === "unhealthy") return "unhealthy";
  if (status === "running" && health === "starting") return "starting";
  return status;
}

function statusToneClass(
  status: DockerStatusResponse["status"],
  health: DockerHealth | undefined,
): string {
  if (status === "running" && health === "unhealthy") {
    return "text-rose-700 dark:text-rose-400";
  }
  if (status === "running" && health === "starting") {
    return "text-sky-700 dark:text-sky-400";
  }
  switch (status) {
    case "running":
      return "text-emerald-700 dark:text-emerald-400";
    case "starting":
      return "text-sky-700 dark:text-sky-400";
    case "restarting":
    case "paused":
    case "stopped":
      return "text-amber-700 dark:text-amber-400";
    case "unavailable":
      return "text-destructive";
    default:
      return "text-foreground";
  }
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded) || Math.abs(rounded % 1) < 1e-9) {
    return `${Math.trunc(rounded)}%`;
  }
  return `${rounded.toFixed(1)}%`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function barClass(percent: number): string {
  if (percent >= 90) return "bg-rose-500/85";
  if (percent >= 75) return "bg-amber-500/85";
  return "bg-emerald-500/85";
}

function valueClass(percent: number): string {
  if (percent >= 90) return "text-rose-600 dark:text-rose-400";
  if (percent >= 75) return "text-amber-700 dark:text-amber-400";
  return "text-foreground/80";
}

function ResourceRow({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number;
  detail?: string | undefined;
}): JSX.Element {
  const title = detail
    ? `${label} ${formatPercent(percent)}（${detail}）`
    : `${label} ${formatPercent(percent)}`;

  return (
    <div
      data-slot="docker-metric-row"
      className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2"
      title={title}
    >
      <span className="text-[11px] font-medium leading-none text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0">
        <div
          className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={title}
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-out",
              barClass(percent),
            )}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
        {detail ? (
          <div className="mt-0.5 truncate text-[10px] leading-none text-muted-foreground/75">
            {detail}
          </div>
        ) : null}
      </div>
      <span
        className={cn(
          "min-w-[2.5rem] text-right text-[11px] font-semibold tabular-nums leading-none",
          valueClass(percent),
        )}
      >
        {formatPercent(percent)}
      </span>
    </div>
  );
}

function RunningMetrics({
  data,
}: {
  data: Extract<DockerStatusResponse, { status: "running" }>;
}): JSX.Element | null {
  const hasCpu = data.cpuPercent !== undefined;
  const hasMem = data.memoryPercent !== undefined;
  if (!hasCpu && !hasMem) {
    return null;
  }

  let memDetail: string | undefined;
  if (
    data.memoryUsageBytes !== undefined &&
    data.memoryLimitBytes !== undefined
  ) {
    memDetail = `${formatBytes(data.memoryUsageBytes)} / ${formatBytes(data.memoryLimitBytes)}`;
  } else if (data.memoryUsageBytes !== undefined) {
    memDetail = formatBytes(data.memoryUsageBytes);
  }

  return (
    <div
      data-slot="docker-metrics"
      className="flex w-full min-w-0 flex-col gap-1.5 rounded-md bg-foreground/[0.035] px-2 py-1.5 dark:bg-foreground/[0.05]"
      aria-label={[
        hasCpu ? `CPU ${formatPercent(data.cpuPercent!)}` : null,
        hasMem
          ? `内存 ${formatPercent(data.memoryPercent!)}${memDetail ? ` ${memDetail}` : ""}`
          : null,
      ]
        .filter(Boolean)
        .join("，")}
    >
      {hasCpu ? <ResourceRow label="CPU" percent={data.cpuPercent!} /> : null}
      {hasMem ? (
        <ResourceRow
          label="内存"
          percent={data.memoryPercent!}
          detail={memDetail}
        />
      ) : null}
    </div>
  );
}

export function DockerSlot({
  server,
  container,
  mode = "full",
  className,
}: DockerSlotProps): JSX.Element | null {
  const state = useDockerStatusEntry(server, container);
  const store = useOptionalDockerStatusStore();

  const handleRetry = useCallback(() => {
    store?.refresh();
  }, [store]);

  // metrics 模式：仅在成功且 running 时渲染资源条
  if (mode === "metrics") {
    if (state.status !== "success" || state.data.status !== "running") {
      return null;
    }
    return <RunningMetrics data={state.data} />;
  }

  if (state.status === "loading") {
    const label = dockerStatusText("loading");
    return (
      <div
        data-slot="docker-slot"
        data-state="loading"
        data-mode={mode}
        role="status"
        aria-label={label}
        className={cn(
          "inline-flex h-5 items-center gap-1.5 text-xs leading-none text-muted-foreground",
          className,
        )}
      >
        <StatusIcon state="loading" />
        <span className="truncate">{label}</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        data-slot="docker-slot"
        data-state="error"
        data-mode={mode}
        role="status"
        aria-label={state.message}
        className={cn(
          "inline-flex max-w-[9rem] flex-wrap items-center gap-1 text-xs leading-none text-destructive",
          className,
        )}
        title={state.message}
      >
        <StatusIcon state="error" />
        {mode === "badge" ? (
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={handleRetry}
          >
            {messages.common.retry}
          </button>
        ) : (
          <>
            <span className="truncate">{state.message}</span>
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={handleRetry}
            >
              {messages.common.retry}
            </button>
          </>
        )}
      </div>
    );
  }

  const data = state.data;
  const reason = data.status === "unavailable" ? data.reason : undefined;
  const health = data.status !== "unavailable" ? data.health : undefined;
  const label = dockerStatusText(data.status, reason, { health });
  const uiState = resolveUiState(data.status, health);
  const tone = statusToneClass(data.status, health);
  const title =
    data.status !== "unavailable" ? data.detail : reason;

  if (mode === "badge") {
    return (
      <div
        data-slot="docker-slot"
        data-state={data.status}
        data-health={health}
        data-mode="badge"
        role="status"
        aria-label={label}
        className={cn(
          "inline-flex h-5 max-w-[7.5rem] items-center gap-1.5 text-xs leading-none",
          className,
        )}
        title={title ?? label}
      >
        <StatusIcon state={uiState} />
        <span className={cn("truncate font-medium", tone)}>{label}</span>
      </div>
    );
  }

  return (
    <div
      data-slot="docker-slot"
      data-state={data.status}
      data-health={health}
      data-mode="full"
      role="status"
      aria-label={label}
      className={cn("flex w-full min-w-0 flex-col gap-1 text-xs", className)}
    >
      <div className="inline-flex min-h-5 items-center gap-1.5 leading-none">
        <StatusIcon state={uiState} />
        <span className={cn("truncate font-medium", tone)} title={title}>
          {label}
        </span>
      </div>
      {data.status === "running" ? <RunningMetrics data={data} /> : null}
    </div>
  );
}
