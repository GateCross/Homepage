import {
  BOOKMARK_MIN_ITEM_WIDTH_PX,
  type BookmarkGroupItem,
  type NormalizedConfig,
} from "@homepage/domain";
import type { JSX } from "react";

import { BookmarkItem } from "@/components/bookmarks";
import { EmptyStatus } from "@/components/error";
import {
  ADAPTIVE_GRID_UNBOUNDED_MAX_COLUMNS,
  AdaptiveGrid,
} from "@/components/layout/AdaptiveGrid";
import { CollapsibleGroup } from "@/components/layout/CollapsibleGroup";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

export type BookmarkSectionsProps = {
  groups: NormalizedConfig["bookmarks"];
  className?: string;
};

function isBookmarkError(
  item: BookmarkGroupItem,
): item is Extract<BookmarkGroupItem, { kind: "error" }> {
  return "kind" in item && item.kind === "error";
}

function countRenderableItems(
  groups: NormalizedConfig["bookmarks"],
): number {
  let total = 0;
  for (const group of groups) {
    total += group.items.length;
  }
  return total;
}

export function BookmarkSections({
  groups,
  className,
}: BookmarkSectionsProps): JSX.Element {
  const hasContent = groups.length > 0 && countRenderableItems(groups) > 0;

  if (!hasContent) {
    return (
      <section
        aria-label={messages.layout.bookmarksSection}
        data-slot="bookmark-sections"
        className={cn("w-full", className)}
      >
        <EmptyStatus message={messages.empty.bookmarks} />
      </section>
    );
  }

  return (
    <section
      aria-label={messages.layout.bookmarksSection}
      data-slot="bookmark-sections"
      className={cn("flex w-full flex-col gap-6", className)}
    >
      {groups.map((group) => (
        <CollapsibleGroup
          key={group.name}
          scope="bookmarks"
          name={group.name}
          count={group.items.length}
          data-slot="bookmark-group"
          data-group-name={group.name}
        >
          {group.items.length === 0 ? (
            <EmptyStatus message={messages.empty.bookmarks} />
          ) : (
            <AdaptiveGrid
              as="ul"
              minItemWidth={BOOKMARK_MIN_ITEM_WIDTH_PX}
              maxColumns={ADAPTIVE_GRID_UNBOUNDED_MAX_COLUMNS}
              gap={8}
            >
              {group.items.map((item, index) => {
                if (isBookmarkError(item)) {
                  return (
                    <li
                      key={`${group.name}-error-${index}`}
                      className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive backdrop-blur-md"
                    >
                      {item.message}
                    </li>
                  );
                }
                return (
                  <li key={item.id} className="list-none">
                    <BookmarkItem bookmark={item} />
                  </li>
                );
              })}
            </AdaptiveGrid>
          )}
        </CollapsibleGroup>
      ))}
    </section>
  );
}
