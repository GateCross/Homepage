import type { CSSProperties, KeyboardEvent, JSX } from "react";

import type { NormalizedBookmark } from "@/lib/contracts";

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
    <div className="flex w-full items-center gap-2.5">
      <BookmarkIconView
        icon={bookmark.icon}
        abbr={bookmark.abbr}
        name={bookmark.name}
        className="size-8"
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-snug tracking-tight text-foreground transition-colors group-hover:text-primary">
          {bookmark.name}
        </span>
        {bookmark.description !== undefined && bookmark.description.length > 0 ? (
          <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-muted-foreground">
            {bookmark.description}
          </p>
        ) : null}
      </div>
    </div>
  );

  const shellClass = cn(
    "group surface-card homepage-rise flex h-full min-h-0 items-center rounded-xl px-2.5 py-2",
    isNavigable &&
      "surface-card-interactive cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
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
