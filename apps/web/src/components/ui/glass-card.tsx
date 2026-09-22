import type { CSSProperties, KeyboardEvent, ReactNode, JSX } from "react";
import { cn } from "@/lib/utils";

export type GlassCardProps = {
  children: ReactNode;
  className?: string;
  accentClass?: string;
  isInteractive?: boolean;
  style?: CSSProperties;
  onClick?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  role?: string;
  tabIndex?: number;
  title?: string;
};

export function GlassCard({
  children,
  className,
  accentClass,
  isInteractive = false,
  style,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  title,
}: GlassCardProps): JSX.Element {
  return (
    <div
      role={role}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={title}
      style={style}
      className={cn(
        "group relative overflow-hidden rounded-[var(--radius-lg)] border border-border/70",
        "bg-card/75 backdrop-blur-md text-card-foreground shadow-xs transition-all duration-200",
        "dark:bg-card/45 dark:border-white/10 dark:shadow-none",
        isInteractive && [
          "cursor-pointer hover:border-border hover:bg-card/90 hover:shadow-md",
          "dark:hover:border-white/20 dark:hover:bg-card/65",
          "hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99]",
          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        ],
        accentClass,
        className,
      )}
    >
      {children}
    </div>
  );
}
