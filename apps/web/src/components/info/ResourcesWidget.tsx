import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";

import type { ResourceItem, ResourcesInfoResponse } from "@homepage/domain";

import { ErrorStatus, LoadingStatus } from "@/components/error";
import { fetchInfo, isApiClientError } from "@/lib/api";
import {
  formatPublicError,
  formatUnknownError,
} from "@/lib/format-error";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

export const RESOURCES_POLL_INTERVAL_MS = 30_000;

export type ResourcesWidgetProps = {
  infoId: string;
  className?: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: ResourcesInfoResponse };

function resolveErrorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    if (error.publicError) {
      return formatPublicError(error.publicError, messages.error.info);
    }
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : messages.error.info;
  }
  return formatUnknownError(error, messages.error.info);
}

export function asResourcesInfo(body: unknown): ResourcesInfoResponse | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj["items"])) {
    return null;
  }
  const items: ResourceItem[] = [];
  for (const raw of obj["items"]) {
    if (raw === null || typeof raw !== "object") {
      return null;
    }
    const item = raw as Record<string, unknown>;
    if (typeof item["id"] !== "string" || item["id"].trim().length === 0) {
      return null;
    }
    if (
      typeof item["label"] !== "string" ||
      item["label"].trim().length === 0
    ) {
      return null;
    }
    if (item["status"] === "unavailable") {
      if (
        typeof item["message"] !== "string" ||
        item["message"].trim().length === 0
      ) {
        return null;
      }
      items.push({
        id: item["id"],
        label: item["label"],
        status: "unavailable",
        message: item["message"],
      });
      continue;
    }
    if (
      typeof item["percent"] !== "number" ||
      !Number.isFinite(item["percent"])
    ) {
      return null;
    }
    const percent = Math.min(100, Math.max(0, item["percent"]));
    const usedBytes =
      typeof item["usedBytes"] === "number" &&
      Number.isFinite(item["usedBytes"]) &&
      item["usedBytes"] >= 0
        ? item["usedBytes"]
        : undefined;
    const totalBytes =
      typeof item["totalBytes"] === "number" &&
      Number.isFinite(item["totalBytes"]) &&
      item["totalBytes"] > 0
        ? item["totalBytes"]
        : undefined;
    items.push({
      id: item["id"],
      label: item["label"],
      percent,
      ...(usedBytes !== undefined ? { usedBytes } : {}),
      ...(totalBytes !== undefined ? { totalBytes } : {}),
    });
  }
  return { items };
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

function formatUsageDetail(
  usedBytes: number | undefined,
  totalBytes: number | undefined,
): string | undefined {
  if (usedBytes !== undefined && totalBytes !== undefined) {
    return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
  }
  if (usedBytes !== undefined) return formatBytes(usedBytes);
  if (totalBytes !== undefined) return formatBytes(totalBytes);
  return undefined;
}

function isPathLabel(label: string): boolean {
  return label.startsWith("/") || /^[A-Za-z]:[\\/]/.test(label);
}

/**
 * 资源行标签：
 * - 已配置别名（非路径字符串）→ 原样展示
 * - 路径 → 末段优先；根路径 →「磁盘」
 * title 始终尽量给出完整路径（从 id 的 disk: 前缀解析）
 */
function formatResourceLabel(
  label: string,
  itemId: string,
): { text: string; title: string } {
  const t = label.trim();
  const pathFromId = itemId.startsWith("disk:")
    ? itemId.slice("disk:".length)
    : "";

  if (t.length === 0) {
    return { text: "—", title: pathFromId || "" };
  }

  if (t.toLowerCase() === "cpu") return { text: "CPU", title: "CPU" };
  if (t === "内存" || /^mem(ory)?$/i.test(t)) return { text: "内存", title: t };
  if (t === "磁盘" || t.toLowerCase() === "disk") {
    return { text: "磁盘", title: pathFromId || "/" };
  }

  // 非路径：视为用户别名，直接展示
  if (!isPathLabel(t)) {
    return { text: t, title: pathFromId || t };
  }

  const normalized = t.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (normalized === "/" || normalized === "") {
    return { text: "磁盘", title: "/" };
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return { text: "磁盘", title: t };
  // 只取末段，更干净；完整路径放 title
  const last = parts[parts.length - 1]!;
  return { text: last, title: t };
}

function barClass(percent: number): string {
  if (percent >= 90) return "bg-rose-500/85";
  if (percent >= 75) return "bg-amber-500/85";
  return "bg-emerald-500/85";
}

function valueClass(percent: number): string {
  if (percent >= 90) return "text-rose-600 dark:text-rose-400";
  if (percent >= 75) return "text-amber-700 dark:text-amber-400";
  return "text-foreground/85";
}

function ResourceRow({ item }: { item: ResourceItem }): JSX.Element {
  const { text: labelText, title: labelTitle } = formatResourceLabel(
    item.label,
    item.id,
  );

  if ("status" in item && item.status === "unavailable") {
    return (
      <li
        data-slot="resource-item"
        data-resource-id={item.id}
        data-resource-state="unavailable"
        className="flex flex-col gap-1"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="min-w-0 truncate text-xs font-medium text-muted-foreground"
            title={labelTitle || undefined}
          >
            {labelText}
          </span>
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
            不可用
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8" />
        <p className="text-[11px] leading-snug text-muted-foreground">
          {item.message}
        </p>
      </li>
    );
  }

  const percent = "percent" in item ? item.percent : 0;
  const usedBytes = "usedBytes" in item ? item.usedBytes : undefined;
  const totalBytes = "totalBytes" in item ? item.totalBytes : undefined;
  const detail = formatUsageDetail(usedBytes, totalBytes);
  const aria = detail
    ? `${labelTitle || item.label} ${formatPercent(percent)}（${detail}）`
    : `${labelTitle || item.label} ${formatPercent(percent)}`;

  return (
    <li
      data-slot="resource-item"
      data-resource-id={item.id}
      data-resource-state="ok"
      className="flex flex-col gap-1"
      title={aria}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="min-w-0 truncate text-xs font-medium text-muted-foreground"
          title={labelTitle || undefined}
        >
          {labelText}
          {detail ? (
            <span className="font-normal tabular-nums text-muted-foreground/75">
              （{detail}）
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "shrink-0 text-xs font-semibold tabular-nums leading-none",
            valueClass(percent),
          )}
        >
          {formatPercent(percent)}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/8"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={aria}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            barClass(percent),
          )}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </li>
  );
}

export function ResourcesWidget({
  infoId,
  className,
}: ResourcesWidgetProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const hasSuccessRef = useRef(false);
  const visibleRef = useRef(
    typeof document === "undefined"
      ? true
      : document.visibilityState !== "hidden",
  );

  const load = useCallback(
    async (signal: AbortSignal, options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent || !hasSuccessRef.current) {
        setState({ status: "loading" });
      }

      try {
        const body = await fetchInfo(infoId, { signal });
        if (signal.aborted) {
          return;
        }
        const data = asResourcesInfo(body);
        if (data === null) {
          hasSuccessRef.current = false;
          setState({
            status: "error",
            message: messages.error.invalidResponse,
          });
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
        setState({
          status: "error",
          message: resolveErrorMessage(error),
        });
      }
    },
    [infoId],
  );

  useEffect(() => {
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

    const startTimer = (): void => {
      clearTimer();
      timerId = window.setInterval(() => {
        if (!visibleRef.current) {
          return;
        }
        abortRef.current?.abort();
        const next = new AbortController();
        abortRef.current = next;
        void load(next.signal, { silent: true });
      }, RESOURCES_POLL_INTERVAL_MS);
    };

    const onVisibility = (): void => {
      const visible = document.visibilityState !== "hidden";
      visibleRef.current = visible;
      if (visible) {
        abortRef.current?.abort();
        const next = new AbortController();
        abortRef.current = next;
        void load(next.signal, { silent: true });
        startTimer();
      } else {
        clearTimer();
      }
    };

    if (visibleRef.current) {
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

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
    hasSuccessRef.current = false;
    setReloadToken((n) => n + 1);
  }, []);

  if (state.status === "loading") {
    return (
      <div
        data-slot="resources-widget"
        data-state="loading"
        className={cn("min-h-[8.75rem] p-4", className)}
      >
        <LoadingStatus message={messages.loading.resources} skeleton />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        data-slot="resources-widget"
        data-state="error"
        className={cn("min-h-[8.75rem] p-4", className)}
      >
        <ErrorStatus message={state.message} onRetry={handleRetry} />
      </div>
    );
  }

  if (state.data.items.length === 0) {
    return (
      <div
        data-slot="resources-widget"
        data-state="empty"
        className={cn(
          "min-h-[8.75rem] p-4 text-sm text-muted-foreground",
          className,
        )}
        role="status"
      >
        {messages.empty.metrics}
      </div>
    );
  }

  return (
    <div
      data-slot="resources-widget"
      data-state="success"
      data-info-id={infoId}
      className={cn(
        "relative flex min-h-[8.75rem] flex-col justify-between p-4",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_0%,rgba(16,185,129,0.14),transparent_70%)]"
      />

      <p className="relative text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
        资源
      </p>

      <ul className="relative mt-4 flex list-none flex-col gap-3 p-0">
        {state.data.items.map((item) => (
          <ResourceRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
