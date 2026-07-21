import type { JSX } from "react";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { parseThemeMode, type ThemeMode } from "@homepage/domain";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

import { useTheme } from "./theme-provider";

const THEME_OPTIONS: readonly ThemeMode[] = ["system", "light", "dark"] as const;

export function themeModeLabel(mode: ThemeMode): string {
  switch (mode) {
    case "system":
      return messages.theme.system;
    case "light":
      return messages.theme.light;
    case "dark":
      return messages.theme.dark;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function ThemeModeIcon({
  mode,
  className,
}: {
  mode: ThemeMode;
  className?: string;
}): JSX.Element {
  switch (mode) {
    case "light":
      return <SunIcon className={className} aria-hidden />;
    case "dark":
      return <MoonIcon className={className} aria-hidden />;
    case "system":
      return <MonitorIcon className={className} aria-hidden />;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export type ThemeToggleProps = {
  className?: string;
};

/** 主题切换控件。 - 可访问名称含控件用途与当前选择（不得仅用颜色表达状态） - 下拉提供 system / light / dark 三项，当前项以勾选展示 */
export function ThemeToggle({ className }: ThemeToggleProps): JSX.Element {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const currentLabel = themeModeLabel(theme);
  const resolvedLabel = themeModeLabel(resolvedTheme);
  // 触发器可访问名称：用途 + 当前模式；system 时附带解析后的活动主题
  const accessibleName =
    theme === "system"
      ? `${messages.theme.label}：${currentLabel}（${messages.theme.current}${resolvedLabel}）`
      : `${messages.theme.label}：${currentLabel}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="toolbar"
          size="toolbar"
          className={className}
          aria-label={accessibleName}
          title={accessibleName}
        >
          <ThemeModeIcon mode={theme} />
          <span className="hidden sm:inline">{currentLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className={cn(
          "min-w-[11.5rem] rounded-2xl border-0 bg-card/70 p-1.5 text-foreground shadow-[0_18px_48px_-20px_rgba(0,0,0,0.55)] backdrop-blur-xl ring-1 ring-black/5",
          "dark:bg-card/70 dark:ring-white/10 dark:shadow-[0_20px_52px_-18px_rgba(0,0,0,0.75)]",
        )}
      >
        {THEME_OPTIONS.map((mode) => {
          const selected = theme === mode;
          return (
            <DropdownMenuItem
              key={mode}
              role="menuitemradio"
              aria-checked={selected}
              className={cn(
                "cursor-pointer gap-2.5 rounded-xl px-2 py-2 text-[13px] outline-none",
                "focus:bg-foreground/[0.06] dark:focus:bg-white/[0.08]",
                selected && "bg-foreground/[0.06] dark:bg-white/[0.08]",
              )}
              onSelect={() => {
                setTheme(parseThemeMode(mode));
              }}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] dark:bg-white/[0.08]",
                  selected && "bg-primary/12 text-primary dark:bg-primary/20",
                )}
              >
                <ThemeModeIcon mode={mode} className="size-3.5" />
              </span>
              <span className="flex-1 font-medium tracking-tight">
                {themeModeLabel(mode)}
              </span>
              <CheckIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-primary transition-opacity",
                  selected ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
