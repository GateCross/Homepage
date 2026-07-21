import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { messages } from "@/lib/messages";

export type ErrorFallbackVariant = "page" | "section";

export type ErrorFallbackProps = {
  variant?: ErrorFallbackVariant;

  title?: string;

  description?: string;

  detail?: string;

  onRetry?: () => void;

  retryLabel?: string;
  className?: string;
};

export function ErrorFallback({
  variant = "section",
  title,
  description,
  detail,
  onRetry,
  retryLabel = messages.common.retry,
  className,
}: ErrorFallbackProps): JSX.Element {
  const resolvedTitle =
    title ??
    (variant === "page"
      ? messages.boundary.pageTitle
      : messages.boundary.sectionTitle);
  const resolvedDescription =
    description ??
    (variant === "page"
      ? messages.boundary.pageDescription
      : messages.boundary.sectionDescription);

  const isPage = variant === "page";

  return (
    <div
      role="alert"
      data-slot="error-fallback"
      data-variant={variant}
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-destructive/40 bg-card p-4 text-card-foreground shadow-sm",
        isPage &&
          "min-h-[50vh] items-center justify-center px-6 py-12 text-center sm:min-h-[60vh]",
        !isPage && "w-full",
        className,
      )}
    >
      <div className={cn("flex max-w-lg flex-col gap-2", isPage && "items-center")}>
        <h2
          className={cn(
            "font-semibold tracking-tight text-destructive",
            isPage ? "text-xl" : "text-sm",
          )}
        >
          {resolvedTitle}
        </h2>
        <p
          className={cn(
            "text-muted-foreground",
            isPage ? "text-sm" : "text-xs",
          )}
        >
          {resolvedDescription}
        </p>
        {detail ? (
          <details
            className={cn(
              "mt-1 w-full rounded-md border border-border bg-muted/40 text-left",
              isPage ? "text-xs" : "text-[11px]",
            )}
          >
            <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground">
              {messages.boundary.detailsLabel}
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-foreground/90">
              {detail}
            </pre>
          </details>
        ) : null}
      </div>
      {onRetry ? (
        <div className={cn(isPage && "mt-2")}>
          <Button
            type="button"
            variant={isPage ? "default" : "outline"}
            size={isPage ? "default" : "sm"}
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
