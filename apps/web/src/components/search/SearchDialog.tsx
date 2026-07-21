import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";

import {
  matchSearch,
  type BookmarkGroupItem,
  type NormalizedBookmark,
  type NormalizedConfig,
  type NormalizedService,
  type SearchableItem,
  type ServiceGroupItem,
} from "@homepage/domain";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { messages } from "@/lib/messages";
import { openSafeHref, resolveSafeHref } from "@/lib/safe-link";
import { cn } from "@/lib/utils";

export type SearchDialogItem = SearchableItem & {
  kind: "service" | "bookmark";
  description?: string | undefined;
};

export type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: NormalizedConfig["services"];
  bookmarks: NormalizedConfig["bookmarks"];
  className?: string;
};

function isServiceError(
  item: ServiceGroupItem,
): item is Extract<ServiceGroupItem, { kind: "error" }> {
  return "kind" in item && item.kind === "error";
}

function isBookmarkError(
  item: BookmarkGroupItem,
): item is Extract<BookmarkGroupItem, { kind: "error" }> {
  return "kind" in item && item.kind === "error";
}

function collectSearchItems(
  services: NormalizedConfig["services"],
  bookmarks: NormalizedConfig["bookmarks"],
): SearchDialogItem[] {
  const items: SearchDialogItem[] = [];

  for (const group of services) {
    for (const item of group.items) {
      if (isServiceError(item)) {
        continue;
      }
      const service: NormalizedService = item;
      const entry: SearchDialogItem = {
        id: `service:${service.id}`,
        kind: "service",
        name: service.name,
        target: service.target,
      };
      if (service.href !== undefined) {
        entry.href = service.href;
      }
      if (service.description !== undefined) {
        entry.description = service.description;
      }
      items.push(entry);
    }
  }

  for (const group of bookmarks) {
    for (const item of group.items) {
      if (isBookmarkError(item)) {
        continue;
      }
      const bookmark: NormalizedBookmark = item;
      const entry: SearchDialogItem = {
        id: `bookmark:${bookmark.id}`,
        kind: "bookmark",
        name: bookmark.name,
        href: bookmark.href,
        target: bookmark.target,
      };
      if (bookmark.description !== undefined) {
        entry.description = bookmark.description;
      }
      items.push(entry);
    }
  }

  return items;
}

export function SearchDialog({
  open,
  onOpenChange,
  services,
  bookmarks,
  className,
}: SearchDialogProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [invalidHint, setInvalidHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const allItems = useMemo(
    () => collectSearchItems(services, bookmarks),
    [services, bookmarks],
  );

  const results = useMemo(
    () => matchSearch(allItems, query),
    [allItems, query],
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setInvalidHint(null);
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  const handleSelect = useCallback(
    (item: SearchDialogItem) => {
      const resolved = resolveSafeHref(item.href, item.target);
      if (!resolved.ok) {
        setInvalidHint(messages.search.emptyHref);
        return;
      }
      const opened = openSafeHref(item.href, item.target);
      if (!opened) {
        setInvalidHint(messages.search.emptyHref);
        return;
      }
      setInvalidHint(null);
      onOpenChange(false);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="search-dialog"
        className={cn("overflow-hidden p-0 sm:max-w-lg", className)}
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onOpenChange(false);
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{messages.search.label}</DialogTitle>
          <DialogDescription>{messages.search.hint}</DialogDescription>
        </DialogHeader>
        <Command
          shouldFilter={false}
          className="rounded-lg border-0 shadow-none"
        >
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setInvalidHint(null);
            }}
            placeholder={messages.search.placeholder}
            aria-label={messages.search.label}
          />
          <CommandList>
            <CommandEmpty>{messages.search.noResults}</CommandEmpty>
            {results.length > 0 ? (
              <CommandGroup heading={messages.search.navigateHint}>
                {results.map((item) => {
                  const kindLabel =
                    item.kind === "service"
                      ? messages.layout.servicesSection
                      : messages.layout.bookmarksSection;
                  return (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      onSelect={() => {
                        handleSelect(item);
                      }}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate font-medium">{item.name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {kindLabel}
                        </span>
                      </span>
                      {item.description ? (
                        <span className="line-clamp-1 w-full text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
          {invalidHint ? (
            <p
              role="status"
              className="border-t border-border px-3 py-2 text-xs text-destructive"
            >
              {invalidHint}
            </p>
          ) : null}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
