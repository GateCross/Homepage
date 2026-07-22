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

export type WidgetSlotProps = {
  widgetId?: string | undefined;
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

function MetricsList({ metrics }: { metrics: readonly Metric[] }): JSX.Element {
  if (metrics.length === 0) {
    return <EmptyStatus message={messages.empty.metrics} className="py-2" />;
  }
  return (
    <ul
      className="flex list-none flex-col gap-1 rounded-md bg-foreground/[0.035] px-2 py-1.5 dark:bg-foreground/[0.05]"
      data-slot="widget-metrics"
    >
      {metrics.map((metric) => (
        <li
          key={metric.id}
          data-metric-id={metric.id}
          data-metric-status={metric.status ?? "ok"}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3"
        >
          <span className="truncate text-[11px] font-medium leading-none text-muted-foreground">
            {metric.label}
          </span>
          <span
            className={cn(
              "min-w-[3.5rem] text-right text-[11px] font-semibold tabular-nums leading-none",
              metricStatusClass(metric.status),
            )}
          >
            {metric.status === "unavailable"
              ? `${formatMetricValue(metric)}（不可用）`
              : formatMetricValue(metric)}
          </span>
        </li>
      ))}
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
  unsupported,
  configError,
  className,
}: WidgetSlotProps): JSX.Element | null {
  const [state, setState] = useState<SlotState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const shouldFetch =
    !unsupported &&
    (configError === undefined || configError.trim().length === 0) &&
    typeof widgetId === "string" &&
    widgetId.trim().length > 0;

  useEffect(() => {
    if (!shouldFetch || widgetId === undefined) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading" });

    void (async () => {
      try {
        const result = await fetchWidget(widgetId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (!result.ok) {
          setState({ status: "error", message: result.error });
          return;
        }
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
        setState({ status: "error", message: resolveErrorMessage(error) });
      }
    })();

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [shouldFetch, widgetId, reloadToken]);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
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
