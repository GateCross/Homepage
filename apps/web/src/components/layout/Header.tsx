import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Search, Settings2 } from "lucide-react";

import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { resolveBrandFavicon } from "@/lib/asset-path";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

import { DASHBOARD_SHELL_CLASS } from "./shell";
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

  const showIcon = !iconFailed;

  return (
    <header
      data-slot="dashboard-header"
      className={cn(
        // sticky 顶栏：整条毛玻璃贴顶，不再留可透出下层内容的空隙
        "sticky top-0 z-40 border-b border-white/15 bg-background/65 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/50 dark:border-white/10 dark:bg-background/60 dark:supports-[backdrop-filter]:bg-background/45",
        className,
      )}
    >
      <div
        className={cn(
          DASHBOARD_SHELL_CLASS,
          "flex items-center justify-between gap-4 py-2.5 sm:py-3",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          {showIcon ? (
            <img
              src={faviconSrc}
              alt=""
              width={28}
              height={28}
              decoding="async"
              className="h-7 w-7 min-w-7 shrink-0 rounded-lg object-contain shadow-sm ring-1 ring-white/30 dark:ring-white/15"
              onError={() => setIconFailed(true)}
            />
          ) : null}
          <div className="flex min-w-0 items-baseline gap-2 sm:gap-2.5">
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground [text-shadow:0_1px_2px_rgba(0,0,0,0.28)] sm:text-lg">
              {title}
            </h1>
            <VersionLabel />
          </div>
        </div>
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
          >
            <Search aria-hidden="true" />
            <span className="hidden sm:inline">{messages.search.label}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
