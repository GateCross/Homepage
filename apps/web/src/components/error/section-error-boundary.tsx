import { Component, type ErrorInfo, type ReactNode } from "react";

import { formatUnknownError } from "@/lib/format-error";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

import { ErrorFallback } from "./error-fallback";

export type SectionErrorBoundaryProps = {
  children: ReactNode;

  label?: string;

  resetKeys?: ReadonlyArray<unknown>;
  onReset?: () => void;
  onError?: (error: Error, info: ErrorInfo) => void;
  fallback?: ReactNode | ((args: {
    error: Error;
    reset: () => void;
  }) => ReactNode);
  title?: string;
  description?: string;
  className?: string;
};

type SectionErrorBoundaryState = {
  error: Error | null;
};

function arraysShallowEqual(
  a: ReadonlyArray<unknown> | undefined,
  b: ReadonlyArray<unknown> | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  override state: SectionErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SectionErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prevProps: SectionErrorBoundaryProps): void {
    const { error } = this.state;
    const { resetKeys } = this.props;
    if (
      error &&
      resetKeys &&
      !arraysShallowEqual(prevProps.resetKeys, resetKeys)
    ) {
      this.reset();
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    const {
      children,
      fallback,
      title,
      description,
      label,
      className,
    } = this.props;

    if (error) {
      if (typeof fallback === "function") {
        return fallback({ error, reset: this.reset });
      }
      if (fallback !== undefined) {
        return fallback;
      }

      const resolvedTitle = title ?? messages.boundary.sectionTitle;
      const resolvedDescription =
        description ??
        (label
          ? `「${label}」${messages.boundary.sectionDescription}`
          : messages.boundary.sectionDescription);

      return (
        <div
          data-slot="section-error-boundary"
          aria-label={label}
          className={cn("w-full", className)}
        >
          <ErrorFallback
            variant="section"
            title={resolvedTitle}
            description={resolvedDescription}
            detail={formatUnknownError(error)}
            onRetry={this.reset}
          />
        </div>
      );
    }

    return children;
  }
}
