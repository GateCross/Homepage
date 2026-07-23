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
import { useGroupActive } from "@/lib/group-active";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

/** 下载客户端：较快静默刷新 */
export const TORRENT_WIDGET_POLL_INTERVAL_MS = 15_000;
/** Emby / Custom API 等：较慢静默刷新 */
export const WIDGET_POLL_INTERVAL_MS = 30_000;
/**
 * 前端请求超时。
 * 适配器单跳约 10s；qBittorrent 等会先鉴权再拉数，端到端需覆盖多段预算。
 */
export const WIDGET_FETCH_TIMEOUT_MS = 30_000;
/** 成功数据超过此时长仍未刷新成功，展示「最后更新」 */
export const WIDGET_STALE_MS = 90_000;

const TORRENT_WIDGET_TYPES = new Set(["qbittorrent", "transmission"]);
const POLLING_WIDGET_TYPES = new Set([
  "qbittorrent",
  "transmission",
  "emby",
  "customapi",
]);

export type WidgetSlotProps = {
  widgetId?: string | undefined;
  /** 组件类型，用于决定轮询间隔 */
  widgetType?: string | undefined;
  unsupported?: boolean | undefined;
  configError?: string | undefined;
  className?: string;
};

type SlotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "success";
      data: Extract<ServiceWidgetResult, { ok: true }>;
      fetchedAt: number;
    };

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

function formatStaleAge(fetchedAt: number, now: number): string {
  const ageSec = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (ageSec < 60) {
    return `最后更新 ${ageSec}s 前`;
  }
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) {
    return `最后更新 ${ageMin} 分钟前`;
  }
  const ageHour = Math.floor(ageMin / 60);
  return `最后更新 ${ageHour} 小时前`;
}

function pollIntervalForType(widgetType: string | undefined): number | null {
  if (typeof widgetType !== "string") {
    return null;
  }
  const type = widgetType.trim().toLowerCase();
  if (!POLLING_WIDGET_TYPES.has(type)) {
    return null;
  }
  if (TORRENT_WIDGET_TYPES.has(type)) {
    return TORRENT_WIDGET_POLL_INTERVAL_MS;
  }
  return WIDGET_POLL_INTERVAL_MS;
}

export function WidgetSlot({
  widgetId,
  widgetType,
  unsupported,
  configError,
  className,
}: WidgetSlotProps): JSX.Element | null {
  const groupActive = useGroupActive();
  const [state, setState] = useState<SlotState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const hasLoadedRef = useRef(false);
  const pageVisibleRef = useRef(
    typeof document === "undefined"
      ? true
      : document.visibilityState !== "hidden",
  );
  const groupActiveRef = useRef(groupActive);
  const wasGroupActiveRef = useRef(groupActive);
  groupActiveRef.current = groupActive;

  const shouldFetch =
    !unsupported &&
    (configError === undefined || configError.trim().length === 0) &&
    typeof widgetId === "string" &&
    widgetId.trim().length > 0;

  const pollIntervalMs = pollIntervalForType(widgetType);

  const load = useCallback(
    async (signal: AbortSignal, options?: { silent?: boolean }) => {
      if (widgetId === undefined) {
        return;
      }
      const silent = options?.silent === true;
      if (!silent || !hasLoadedRef.current) {
        setState({ status: "loading" });
      }

      try {
        const result = await fetchWidget(widgetId, {
          signal,
          timeoutMs: WIDGET_FETCH_TIMEOUT_MS,
        });
        if (signal.aborted) {
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
        setState({
          status: "success",
          data: result,
          fetchedAt: Date.now(),
        });
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
        if (silent && hasLoadedRef.current) {
          return;
        }
        if (!hasLoadedRef.current) {
          setState({ status: "error", message: resolveErrorMessage(error) });
        }
      }
    },
    [widgetId],
  );

  useEffect(() => {
    if (!shouldFetch || widgetId === undefined) {
      return;
    }
    // widgetId 等依赖变化时重置，避免复用实例时 silent 短路导致卡在 loading
    hasLoadedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    // 折叠组首次挂载仍拉一次数据，后续轮询由 groupActive 控制
    void load(controller.signal);

    let pollTimerId: number | null = null;
    let staleTimerId: number | null = null;

    const isActive = (): boolean =>
      pageVisibleRef.current && groupActiveRef.current;

    const clearPollTimer = (): void => {
      if (pollTimerId !== null) {
        window.clearInterval(pollTimerId);
        pollTimerId = null;
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

    const startPollTimer = (): void => {
      clearPollTimer();
      if (pollIntervalMs === null) {
        return;
      }
      pollTimerId = window.setInterval(tick, pollIntervalMs);
    };

    const onVisibility = (): void => {
      const visible = document.visibilityState !== "hidden";
      pageVisibleRef.current = visible;
      if (visible) {
        if (pollIntervalMs !== null) {
          // 折叠组不主动拉；timer 仍挂着，展开后由 tick 恢复
          if (groupActiveRef.current) {
            tick();
          }
          startPollTimer();
        }
        if (groupActiveRef.current) {
          setNowMs(Date.now());
        }
      } else {
        clearPollTimer();
      }
    };

    // 即使分组折叠也挂 timer，tick 内按 isActive 短路，避免展开后无轮询
    if (pageVisibleRef.current && pollIntervalMs !== null) {
      startPollTimer();
    }

    // 成功数据陈旧提示需要周期性刷新「最后更新」文案
    staleTimerId = window.setInterval(() => {
      if (isActive()) {
        setNowMs(Date.now());
      }
    }, 15_000);

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearPollTimer();
      if (staleTimerId !== null) {
        window.clearInterval(staleTimerId);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [shouldFetch, widgetId, reloadToken, pollIntervalMs, load]);

  // 分组从折叠展开时补一次静默刷新（首载由主 effect 负责，避免双请求）
  useEffect(() => {
    const wasActive = wasGroupActiveRef.current;
    wasGroupActiveRef.current = groupActive;
    if (!shouldFetch || pollIntervalMs === null) {
      return;
    }
    if (!groupActive || wasActive || !pageVisibleRef.current) {
      return;
    }
    abortRef.current?.abort();
    const next = new AbortController();
    abortRef.current = next;
    void load(next.signal, { silent: true });
  }, [groupActive, shouldFetch, pollIntervalMs, load]);

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
  const isStale = nowMs - state.fetchedAt >= WIDGET_STALE_MS;

  return (
    <div
      data-slot="widget-slot"
      data-state="success"
      data-stale={isStale ? "true" : "false"}
      className={cn("flex flex-col gap-1", className)}
    >
      <MetricsList metrics={metrics} />
      {sessions !== undefined ? <SessionsList sessions={sessions} /> : null}
      {isStale ? (
        <p
          className="text-center text-[10px] leading-none text-muted-foreground/80"
          data-slot="widget-stale"
        >
          {formatStaleAge(state.fetchedAt, nowMs)}
        </p>
      ) : null}
    </div>
  );
}
