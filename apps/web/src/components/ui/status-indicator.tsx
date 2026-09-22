import type { JSX } from "react";
import { cn } from "@/lib/utils";

export type StatusLevel = "online" | "warning" | "danger" | "neutral";

export type StatusIndicatorProps = {
  status: StatusLevel;
  pulse?: boolean;
  label?: string;
  size?: "sm" | "md";
  className?: string;
};

const dotColorMap: Record<StatusLevel, string> = {
  online: "bg-status-online",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
  neutral: "bg-status-neutral",
};

const textColorMap: Record<StatusLevel, string> = {
  online: "text-status-online",
  warning: "text-status-warning",
  danger: "text-status-danger",
  neutral: "text-status-neutral",
};

export function StatusIndicator({
  status,
  pulse = false,
  label,
  size = "sm",
  className,
}: StatusIndicatorProps): JSX.Element {
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-medium tabular-nums select-none",
        size === "sm" ? "text-xs" : "text-sm",
        textColorMap[status],
        className,
      )}
    >
      <span className="relative flex shrink-0 items-center justify-center">
        {pulse && (status === "online" || status === "warning") ? (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              dotColorMap[status],
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex rounded-full", dotSize, dotColorMap[status])} />
      </span>
      {label ? <span className="truncate">{label}</span> : null}
    </span>
  );
}
