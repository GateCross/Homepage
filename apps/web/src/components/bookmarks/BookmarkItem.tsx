import type { CSSProperties, KeyboardEvent, JSX } from "react";

import type { NormalizedBookmark } from "@homepage/domain";

import { BookmarkIconView } from "@/components/shared/ResolvedIconView";
import { SafeExternalLink } from "@/components/ui/safe-external-link";
import { openSafeHref, resolveSafeHref } from "@/lib/safe-link";
import { cn } from "@/lib/utils";

export type BookmarkItemProps = {
  bookmark: NormalizedBookmark;
  className?: string;
  riseDelayMs?: number;
};

export function BookmarkItem({
  bookmark,
  className,
  riseDelayMs,
}: BookmarkItemProps): JSX.Element {
  const link = resolveSafeHref(bookmark.href, bookmark.target);
  const isNavigable = link.ok;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!isNavigable) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSafeHref(bookmark.href, bookmark.target);
    }
  };

  const body = (
    <div className="flex items-center gap-2">
      <BookmarkIconView
        icon={bookmark.icon}
        abbr={bookmark.abbr}
        name={bookmark.name}
      />
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium leading-snug text-foreground">
          {bookmark.name}
        </span>
        <p
          className={cn(
            "mt-0.5 line-clamp-1 min-h-[1.125rem] text-[11px] leading-snug",
            bookmark.description
              ? "text-muted-foreground"
              : "select-none text-transparent",
          )}
          aria-hidden={!bookmark.description ? true : undefined}
        >
          {bookmark.description !== undefined && bookmark.description.length > 0 ? bookmark.description : "\u00A0"}
        </p>
      </div>
    </div>
  );

  const shellClass = cn(
    "group homepage-rise block rounded-[var(--radius-lg)] border border-border/70 bg-card/65 px-2.5 py-2 shadow-xs backdrop-blur-md transition-[border-color,background-color,box-shadow,transform] duration-200 dark:border-white/10 dark:bg-card/50",
    isNavigable &&
      "cursor-pointer hover:-translate-y-0.5 hover:border-border hover:bg-card/85 hover:shadow-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:hover:border-white/20 dark:hover:bg-card/70",
    !isNavigable && "cursor-default",
    className,
  );

  const riseStyle: CSSProperties | undefined =
    riseDelayMs !== undefined
      ? ({
          ["--homepage-rise-delay"]: `${riseDelayMs}ms`,
        } as CSSProperties)
      : undefined;

  if (isNavigable) {
    return (
      <SafeExternalLink
        href={bookmark.href}
        target={bookmark.target}
        data-slot="bookmark-item"
        data-bookmark-id={bookmark.id}
        data-navigable="true"
        className={shellClass}
        style={riseStyle}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {body}
      </SafeExternalLink>
    );
  }

  return (
    <div
      data-slot="bookmark-item"
      data-bookmark-id={bookmark.id}
      data-navigable="false"
      className={shellClass}
      style={riseStyle}
    >
      {body}
    </div>
  );
}
