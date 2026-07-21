import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

function Spinner({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md";
}): JSX.Element {
  const dim = size === "sm" ? "size-4" : "size-8";
  return (
    <span
      aria-hidden="true"
      data-slot="spinner"
      className={cn(
        "relative inline-block shrink-0 rounded-full",
        dim,
        className,
      )}
    >
      <span className="absolute inset-0 rounded-full border-2 border-primary/15" />
      <span className="absolute inset-0 animate-[spin_0.75s_linear_infinite] rounded-full border-2 border-transparent border-t-primary border-r-primary/50" />
    </span>
  );
}

export type LoadingStatusProps = {
  message?: string;
  skeleton?: boolean;
  centered?: boolean;
  className?: string;
};

export function LoadingStatus({
  message = messages.common.loading,
  skeleton = false,
  centered = false,
  className,
}: LoadingStatusProps): JSX.Element {
  if (centered) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        data-slot="loading-status"
        data-variant="centered"
        className={cn(
          "flex flex-col items-center justify-center gap-3 py-6 text-center",
          className,
        )}
      >
        <Spinner size="md" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium tracking-tight text-foreground">
            {message}
          </p>
          <p className="text-xs text-muted-foreground">请稍候</p>
        </div>
        {skeleton ? (
          <div className="mt-2 flex w-full max-w-xs flex-col items-center gap-2">
            <Skeleton className="h-2 w-40 rounded-full" />
            <Skeleton className="h-2 w-28 rounded-full opacity-70" />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-slot="loading-status"
      className={cn(
        "flex items-center gap-2.5 text-sm text-muted-foreground",
        className,
      )}
    >
      <Spinner size="sm" />
      {skeleton ? <Skeleton className="h-3.5 w-28 max-w-[60%]" /> : null}
      <span>{message}</span>
    </div>
  );
}

export type EmptyStatusProps = {
  message?: string;
  className?: string;
  children?: ReactNode;
};

export function EmptyStatus({
  message = messages.common.empty,
  className,
  children,
}: EmptyStatusProps): JSX.Element {
  return (
    <div
      role="status"
      data-slot="empty-status"
      className={cn(
        "rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground",
        className,
      )}
    >
      <p>{message}</p>
      {children}
    </div>
  );
}

export type ErrorStatusProps = {
  message?: string;

  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  children?: ReactNode;
};

export function ErrorStatus({
  message = messages.common.error,
  onRetry,
  retryLabel = messages.common.retry,
  className,
  children,
}: ErrorStatusProps): JSX.Element {
  return (
    <div
      role="alert"
      data-slot="error-status"
      className={cn(
        "flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm",
        className,
      )}
    >
      <p className="text-destructive">{message}</p>
      {children}
      {onRetry ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export type UnsupportedStatusProps = {
  message?: string;
  className?: string;
};

export function UnsupportedStatus({
  message = messages.unsupported.generic,
  className,
}: UnsupportedStatusProps): JSX.Element {
  return (
    <div
      role="status"
      data-slot="unsupported-status"
      className={cn(
        "rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {message}
    </div>
  );
}
