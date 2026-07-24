import { useEffect, useState, type JSX } from "react";
import type { VersionSuccessResponse } from "@homepage/domain";

import { SafeExternalLink } from "@/components/ui/safe-external-link";
import { fetchVersion } from "@/lib/api";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

type VersionState =
  | { status: "loading" }
  | { status: "ready"; data: VersionSuccessResponse }
  | { status: "error" };

function formatVersionLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "v?";
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

/** 页面生命周期内各只跑一次（StrictMode / 状态切换 remount 复用） */
let sharedLocalPromise: Promise<VersionSuccessResponse> | null = null;
let sharedFullPromise: Promise<VersionSuccessResponse> | null = null;

function loadLocalVersionOnce(): Promise<VersionSuccessResponse> {
  if (sharedLocalPromise === null) {
    sharedLocalPromise = fetchVersion({
      checkRemote: false,
      timeoutMs: 5_000,
    }).catch((error: unknown) => {
      sharedLocalPromise = null;
      throw error;
    });
  }
  return sharedLocalPromise;
}

function loadFullVersionOnce(): Promise<VersionSuccessResponse> {
  if (sharedFullPromise === null) {
    sharedFullPromise = fetchVersion({
      checkRemote: true,
      timeoutMs: 12_000,
    }).catch((error: unknown) => {
      sharedFullPromise = null;
      throw error;
    });
  }
  return sharedFullPromise;
}

export type VersionLabelProps = {
  className?: string;
};

/** 顶栏等处展示的当前版本；启动时本地秒回 + 一次远端检查 */
export function VersionLabel({ className }: VersionLabelProps): JSX.Element {
  const [state, setState] = useState<VersionState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const quick = await loadLocalVersionOnce();
        if (!cancelled) {
          setState({ status: "ready", data: quick });
        }
      } catch {
        // 快速路径失败则依赖完整检查
      }

      try {
        const full = await loadFullVersionOnce();
        if (cancelled) return;
        setState({ status: "ready", data: full });
      } catch {
        if (cancelled) return;
        setState((prev) =>
          prev.status === "ready" ? prev : { status: "error" },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <span
        data-slot="version-label"
        aria-live="polite"
        className={cn(
          "shrink-0 text-[11px] tabular-nums text-foreground/55 [text-shadow:0_1px_2px_rgba(0,0,0,0.28)]",
          className,
        )}
      >
        {messages.version.checking}
      </span>
    );
  }

  if (state.status === "error") {
    return (
      <span
        data-slot="version-label"
        className={cn(
          "shrink-0 text-[11px] tabular-nums text-foreground/55 [text-shadow:0_1px_2px_rgba(0,0,0,0.28)]",
          className,
        )}
      >
        {messages.version.label}
        <span className="mx-1 opacity-50">·</span>
        —
      </span>
    );
  }

  return (
    <span
      data-slot="version-label"
      className={cn(
        "inline-flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-none text-foreground/65 [text-shadow:0_1px_2px_rgba(0,0,0,0.28)]",
        className,
      )}
    >
      <span className="tabular-nums text-foreground/80">
        {formatVersionLabel(state.data.version)}
      </span>
      {state.data.updateAvailable && state.data.latestVersion ? (
        <span className="inline-flex items-center gap-1">
          <span
            className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-400/15 dark:text-amber-200"
            role="status"
          >
            {messages.version.updateAvailable}
            <span className="mx-0.5 opacity-60">·</span>
            {formatVersionLabel(state.data.latestVersion)}
          </span>
          {state.data.releaseUrl ? (
            <SafeExternalLink
              href={state.data.releaseUrl}
              className="text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
            >
              {messages.version.viewRelease}
            </SafeExternalLink>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** @deprecated 使用 VersionLabel；保留别名避免外部引用中断 */
export const VersionFooter = VersionLabel;
export type VersionFooterProps = VersionLabelProps;
