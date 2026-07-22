import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";

import type {
  EmbySessionSummary,
  Metric,
  ServiceWidgetResult,
} from "@homepage/domain";

import {
  EmptyStatus,
  ErrorStatus,
  LoadingStatus,
  UnsupportedStatus,
} from "@/components/error";
import { fetchWidget, isApiClientError } from "@/lib/api";
import {
  formatPublicError,
  formatUnknownError,
} from "@/lib/format-error";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

/** qB / Transmission 等下载客户端：定时静默刷新 */
export const TORRENT_WIDGET_POLL_INTERVAL_MS = 15_000;

const TORRENT_WIDGET_TYPES = new Set(["qbittorrent", "transmission"]);

export type WidgetSlotProps = {
  widgetId?: string | undefined;
  /** 组件类型，用于决定是否轮询（qbittorrent / transmission） */
  widgetType?: string | undefined;
  unsupported?: boolean | undefined;
  configError?: string | undefined;
  className?: string;
};

type SlotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: Extract<ServiceWidgetResult, { ok: true }> };

function resolveErrorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    if (error.publicError) {
      return formatPublicError(error.publicError, messages.error.widget);
    }
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : messages.error.widget;
  }
  return formatUnknownError(error, messages.error.widget);
}

function formatMetricValue(metric: Metric): string {
  const unit =
    typeof metric.unit === "string" && metric.unit.trim().length > 0
      ? ` ${metric.unit.trim()}`
      : "";
  return `${String(metric.value)}${unit}`;
}

function metricStatusClass(status: Metric["status"]): string {
  switch (status) {
    case "warn":
      return "text-amber-700 dark:text-amber-300";
    case "error":
      return "text-destructive";
    case "unavailable":
      return "text-muted-foreground";
    case "ok":
    case undefined:
      return "text-foreground";
    default:
      return "text-foreground";
  }
}

function metricsGridClass(count: number): string {
  // 1–3 项单行；4+ 用 2×2，避免速率单位被挤省略（对齐官方 Block 并排块）
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-2";
  if (count === 3) return "grid-cols-3";
  return "grid-cols-2";
}

function MetricsList({ metrics }: { metrics: readonly Metric[] }): JSX.Element {
  if (metrics.length === 0) {
    return <EmptyStatus message={messages.empty.metrics} className="py-2" />;
  }
  return (
    <ul
      className={cn(
        "grid list-none gap-1",
        metricsGridClass(metrics.length),
      )}
      data-slot="widget-metrics"
    >
      {metrics.map((metric) => {
        const display =
          metric.status === "unavailable"
            ? `${formatMetricValue(metric)}（不可用）`
            : formatMetricValue(metric);
        return (
          <li
            key={metric.id}
            data-metric-id={metric.id}
            data-metric-status={metric.status ?? "ok"}
            className="flex min-w-0 flex-col items-center justify-center rounded-md bg-foreground/[0.035] px-1 py-1.5 text-center dark:bg-foreground/[0.05]"
          >
            <span
              className={cn(
                "max-w-full truncate text-xs font-semibold tabular-nums leading-tight sm:text-sm",
                metricStatusClass(metric.status),
              )}
              title={display}
            >
              {display}
            </span>
            <span className="mt-0.5 max-w-full truncate text-[10px] font-medium leading-none text-muted-foreground">
              {metric.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SessionsList({
  sessions,
}: {
  sessions: readonly EmbySessionSummary[];
}): JSX.Element | null {
  if (sessions.length === 0) {
    return null;
  }
  const visible = sessions.slice(0, 5);
  return (
    <div
      className="space-y-1 rounded-md bg-foreground/[0.035] px-2 py-1.5 dark:bg-foreground/[0.05]"
      data-slot="widget-sessions"
    >
      <ul className="flex list-none flex-col gap-1 p-0">
        {visible.map((session) => {
          const parts = [session.title];
          if (session.episode) {
            parts.push(session.episode);
          }
          if (session.user) {
            parts.push(session.user);
          }
          if (
            typeof session.progress === "number" &&
            Number.isFinite(session.progress)
          ) {
            parts.push(`${session.progress}%`);
          }
          return (
            <li
              key={session.id}
              data-session-id={session.id}
              className="truncate text-[11px] leading-snug text-foreground/90"
              title={parts.join(" · ")}
            >
              {parts.join(" · ")}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function WidgetSlot({
  widgetId,
  widgetType,
  unsupported,
  configError,
  className,
}: WidgetSlotProps): JSX.Element | null {
  const [state, setState] = useState<SlotState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const hasLoadedRef = useRef(false);

  const shouldFetch =
    !unsupported &&
    (configError === undefined || configError.trim().length === 0) &&
    typeof widgetId === "string" &&
    widgetId.trim().length > 0;

  const shouldPoll =
    typeof widgetType === "string" &&
    TORRENT_WIDGET_TYPES.has(widgetType.trim().toLowerCase());

  useEffect(() => {
    if (!shouldFetch || widgetId === undefined) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    // 首载显示 loading；轮询刷新静默更新
    if (!hasLoadedRef.current) {
      setState({ status: "loading" });
    }

    void (async () => {
      try {
        const result = await fetchWidget(widgetId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (!result.ok) {
          // 轮询失败时保留上次成功数据，仅首载/手动重试展示错误
          if (!hasLoadedRef.current) {
            setState({ status: "error", message: result.error });
          }
          return;
        }
        hasLoadedRef.current = true;
        setState({ status: "success", data: result });
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
        if (!hasLoadedRef.current) {
          setState({ status: "error", message: resolveErrorMessage(error) });
        }
      }
    })();

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [shouldFetch, widgetId, reloadToken]);

  useEffect(() => {
    if (!shouldFetch || !shouldPoll) {
      return;
    }
    const timerId = window.setInterval(() => {
      setReloadToken((n) => n + 1);
    }, TORRENT_WIDGET_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, [shouldFetch, shouldPoll]);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
    hasLoadedRef.current = false;
    setReloadToken((n) => n + 1);
  }, []);

  if (unsupported) {
    return (
      <div data-slot="widget-slot" data-state="unsupported" className={className}>
        <UnsupportedStatus message={messages.unsupported.widget} />
      </div>
    );
  }

  if (configError !== undefined && configError.trim().length > 0) {
    return (
      <div data-slot="widget-slot" data-state="config-error" className={className}>
        <ErrorStatus message={configError} />
      </div>
    );
  }

  if (!shouldFetch) {
    return null;
  }

  if (state.status === "loading") {
    return (
      <div data-slot="widget-slot" data-state="loading" className={className}>
        <LoadingStatus message={messages.loading.widget} skeleton />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div data-slot="widget-slot" data-state="error" className={className}>
        <ErrorStatus message={state.message} onRetry={handleRetry} />
      </div>
    );
  }

  const { metrics, sessions } = state.data;

  return (
    <div
      data-slot="widget-slot"
      data-state="success"
      className={cn("flex flex-col gap-1", className)}
    >
      <MetricsList metrics={metrics} />
      {sessions !== undefined ? <SessionsList sessions={sessions} /> : null}
    </div>
  );
}
