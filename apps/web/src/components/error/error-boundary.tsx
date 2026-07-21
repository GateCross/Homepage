import { Component, type ErrorInfo, type ReactNode } from "react";

import { formatUnknownError } from "@/lib/format-error";
import { messages } from "@/lib/messages";

import { ErrorFallback } from "./error-fallback";

export type ErrorBoundaryProps = {
  children: ReactNode;

  resetKeys?: ReadonlyArray<unknown>;

  onReset?: () => void;

  onError?: (error: Error, info: ErrorInfo) => void;

  fallback?: ReactNode | ((args: {
    error: Error;
    reset: () => void;
  }) => ReactNode);

  title?: string;

  description?: string;
};

type ErrorBoundaryState = {
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

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
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
    const { children, fallback, title, description } = this.props;

    if (error) {
      if (typeof fallback === "function") {
        return fallback({ error, reset: this.reset });
      }
      if (fallback !== undefined) {
        return fallback;
      }

      return (
        <div className="flex min-h-screen flex-col bg-background px-4 py-8 text-foreground">
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center">
            <ErrorFallback
              variant="page"
              title={title ?? messages.boundary.pageTitle}
              description={description ?? messages.boundary.pageDescription}
              detail={formatUnknownError(error)}
              onRetry={this.reset}
            />
          </div>
        </div>
      );
    }

    return children;
  }
}
