import {
  useCallback,
  useId,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";

import {
  readGroupCollapsed,
  writeGroupCollapsed,
} from "@/lib/group-collapse";
import { GroupActiveProvider, useGroupActive } from "@/hooks/use-group-active";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

export { useGroupActive };

export type CollapsibleGroupProps = {
  /** 持久化作用域，如 "services" / "bookmarks" */
  scope: string;
  name: string;
  /** 分组内条目数，显示在标题旁 */
  count?: number;
  children: ReactNode;
  className?: string;
  "data-slot"?: string;
  "data-group-name"?: string;
  "data-max-columns"?: number | undefined;
};

export function CollapsibleGroup({
  scope,
  name,
  count,
  children,
  className,
  "data-slot": dataSlot,
  "data-group-name": dataGroupName,
  "data-max-columns": dataMaxColumns,
}: CollapsibleGroupProps): JSX.Element {
  const panelId = useId();
  const [collapsed, setCollapsed] = useState(() =>
    readGroupCollapsed(scope, name),
  );

  const handleToggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeGroupCollapsed(scope, name, next);
      return next;
    });
  }, [scope, name]);

  return (
    <div
      data-slot={dataSlot}
      data-group-name={dataGroupName ?? name}
      data-collapsed={collapsed ? "true" : "false"}
      {...(dataMaxColumns !== undefined
        ? { "data-max-columns": dataMaxColumns }
        : {})}
      className={cn("min-w-0", className)}
    >
      <h2 className="mb-3 flex items-center gap-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          aria-label={
            typeof count === "number"
              ? `${name}（${count}）${collapsed ? messages.layout.expandGroup : messages.layout.collapseGroup}`
              : `${name}，${collapsed ? messages.layout.expandGroup : messages.layout.collapseGroup}`
          }
          onClick={handleToggle}
          className={cn(
            "surface-pill group/title inline-flex max-w-full items-center gap-2 rounded-lg px-2.5 py-1.5",
            "text-left transition-[border-color,background-color] duration-150",
            "hover:border-border dark:hover:border-white/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
          )}
        >
          <span
            aria-hidden="true"
            className="h-3.5 w-1 shrink-0 rounded-full bg-primary/80"
          />
          <span
            aria-hidden="true"
            className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground transition-transform duration-200 ease-out will-change-transform group-hover/title:text-foreground"
            style={{
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            }}
          >
            <ChevronRight className="size-3.5" />
          </span>
          <span
            aria-hidden="true"
            className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground sm:text-[0.95rem]"
          >
            {name}
          </span>
          {typeof count === "number" ? (
            <span
              aria-hidden="true"
              className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[11px] font-medium tabular-nums leading-none text-muted-foreground dark:bg-white/[0.08]"
            >
              {count}
            </span>
          ) : null}
        </button>
        <span
          aria-hidden="true"
          className="h-px flex-1 bg-gradient-to-r from-border/70 via-border/30 to-transparent dark:from-white/15 dark:via-white/6"
        />
      </h2>

      {/* 折叠时仅 hidden 并标记 inactive，保留状态但暂停子树轮询 */}
      <GroupActiveProvider active={!collapsed}>
        <div
          id={panelId}
          role="region"
          aria-label={name}
          hidden={collapsed}
        >
          {children}
        </div>
      </GroupActiveProvider>
    </div>
  );
}
