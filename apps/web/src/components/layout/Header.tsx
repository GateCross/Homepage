import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Search, Settings2 } from "lucide-react";

import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { resolveBrandFavicon } from "@/lib/asset-path";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

import { VersionLabel } from "./VersionFooter";

export type HeaderProps = {
  title: string;
  favicon?: string;
  onSearchOpen?: () => void;
  onConfigOpen?: () => void;
  themeControl?: ReactNode;
  className?: string;
};

export function Header({
  title,
  favicon,
  onSearchOpen,
  onConfigOpen,
  themeControl,
  className,
}: HeaderProps): JSX.Element {
  const [iconFailed, setIconFailed] = useState(false);
  const faviconSrc = resolveBrandFavicon(favicon);

  useEffect(() => {
    setIconFailed(false);
  }, [faviconSrc]);

  return (
    <header
      data-slot="dashboard-header"
      className={cn(
        // sticky 顶栏：稳重半实底毛玻璃贴顶，刘海屏下压到安全区之下
        "sticky top-0 z-40 border-b border-border/60 bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-2xl supports-[backdrop-filter]:bg-background/72 dark:border-white/10 dark:bg-background/80 dark:supports-[backdrop-filter]:bg-background/68",
        className,
      )}
    >
      <div
        className={cn(
          "dashboard-shell",
          "flex items-center justify-between gap-3 py-2.5 sm:gap-4 sm:py-3",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          {!iconFailed ? (
            <img
              src={faviconSrc}
              alt=""
              width={28}
              height={28}
              decoding="async"
              className="h-7 w-7 min-w-7 shrink-0 rounded-lg object-contain ring-1 ring-black/10 dark:ring-white/15"
              onError={() => setIconFailed(true)}
            />
          ) : null}
          <div className="flex min-w-0 items-baseline gap-2 sm:gap-2.5">
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">
              {title}
            </h1>
            <VersionLabel />
          </div>
        </div>

        {/* 桌面端居中命令式搜索入口（Raycast 风格），移动端收进右侧工具栏 */}
        {onSearchOpen ? (
          <button
            type="button"
            aria-label={messages.search.open}
            onClick={onSearchOpen}
            className="surface-pill group/search hidden h-9 w-full max-w-xs items-center justify-between gap-3 rounded-xl px-3 text-sm text-muted-foreground transition-[border-color,background-color,color] duration-150 hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex lg:max-w-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Search
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground/80 transition-colors group-hover/search:text-foreground"
              />
              <span className="truncate text-xs">搜索服务、书签…</span>
            </span>
            <kbd className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background/60 px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground/90 dark:border-white/12 dark:bg-white/[0.06]">
              <span>⌘</span>
              <span>K</span>
            </kbd>
          </button>
        ) : null}

        <div
          data-slot="header-actions"
          role="toolbar"
          aria-label="页面操作"
          className="flex shrink-0 items-center gap-1"
        >
          {themeControl ?? <ThemeToggle />}
          {onConfigOpen ? (
            <Button
              type="button"
              variant="toolbar"
              size="toolbar"
              aria-label="打开配置"
              onClick={onConfigOpen}
            >
              <Settings2 aria-hidden="true" />
              <span className="hidden sm:inline">配置</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="toolbar"
            size="toolbar"
            aria-label={messages.search.open}
            onClick={onSearchOpen}
            className={onSearchOpen ? "md:hidden" : undefined}
          >
            <Search aria-hidden="true" />
            <span className="hidden sm:inline">{messages.search.label}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
