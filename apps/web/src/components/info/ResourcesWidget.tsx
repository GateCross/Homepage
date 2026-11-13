import { useCallback, type JSX } from "react";

import type {
  ResourceItem,
  ResourcesInfoResponse,
} from "@/lib/contracts";

import { ErrorStatus, LoadingStatus } from "@/components/error";
import { usePolledResource } from "@/hooks/use-polled-resource";
import { fetchInfo } from "@/lib/api";
import { resolveErrorMessage } from "@/lib/format-error";
import { formatBytes, formatPercent, usageBarClass, usageToneClass } from "@/lib/format";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

export const RESOURCES_POLL_INTERVAL_MS = 30_000;

export type ResourcesWidgetProps = {
  infoId: string;
  className?: string;
};

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

// 用量条与数值文案走全局状态令牌，明暗适配由令牌自身承担
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
        className="flex flex-col gap-0.5"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="min-w-0 truncate text-[11px] font-medium text-muted-foreground"
            title={labelTitle || undefined}
          >
            {labelText}
          </span>
          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
            不可用
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-foreground/8" />
        <p className="text-[10px] leading-snug text-muted-foreground">
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
      className="flex flex-col gap-0.5"
      title={aria}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="min-w-0 truncate text-[11px] font-medium text-muted-foreground"
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
            "shrink-0 text-[11px] font-semibold tabular-nums leading-none",
            usageToneClass(percent),
          )}
        >
          {formatPercent(percent)}
        </span>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-foreground/8"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={aria}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            usageBarClass(percent),
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
  const load = useCallback(async (signal: AbortSignal) => {
    const body = await fetchInfo(infoId, { signal });
    const data = asResourcesInfo(body);
    if (data === null) {
      // 解析失败按错误处理，交由 hook 决定是否保留上一次成功数据
      throw new Error(messages.error.invalidResponse);
    }
    return data;
  }, [infoId]);

  const resolveError = useCallback(
    (error: unknown) => resolveErrorMessage(error, messages.error.info),
    [],
  );

  const { state, retry } = usePolledResource<ResourcesInfoResponse>({
    load,
    resolveError,
    fallbackMessage: messages.error.info,
    intervalMs: RESOURCES_POLL_INTERVAL_MS,
  });

  if (state.status === "loading") {
    return (
      <div
        data-slot="resources-widget"
        data-state="loading"
        className={cn("min-h-0 p-3", className)}
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
        className={cn("min-h-0 p-3", className)}
      >
        <ErrorStatus message={state.message} onRetry={retry} />
      </div>
    );
  }

  if (state.data.items.length === 0) {
    return (
      <div
        data-slot="resources-widget"
        data-state="empty"
        className={cn(
          "min-h-0 p-3 text-sm text-muted-foreground",
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
        "relative flex h-full min-h-0 flex-col p-3",
        className,
      )}
    >
      <p className="relative text-[10px] font-medium text-muted-foreground">
        资源
      </p>

      <ul className="relative mt-2.5 flex min-h-0 flex-1 list-none flex-col justify-center gap-2 p-0">
        {state.data.items.map((item) => (
          <ResourceRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
