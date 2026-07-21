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
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

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
      <h2 className="mb-2.5">
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
            "group/title -ml-1.5 inline-flex max-w-full items-center gap-2 rounded-lg px-1.5 py-1",
            "text-left transition-colors duration-150",
            "hover:bg-white/10 dark:hover:bg-white/5",
            "active:bg-white/15 dark:active:bg-white/8",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
          )}
        >
          <span
            aria-hidden="true"
            className="inline-flex size-3.5 shrink-0 items-center justify-center text-foreground/75 transition-transform duration-200 ease-out will-change-transform [text-shadow:0_1px_2px_rgba(0,0,0,0.28)] group-hover/title:text-foreground"
            style={{
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            }}
          >
            <ChevronRight className="size-3.5" strokeWidth={2.5} />
          </span>
          <span
            aria-hidden="true"
            className="h-3.5 w-0.5 shrink-0 rounded-full bg-primary/80"
          />
          <span
            aria-hidden="true"
            className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground [text-shadow:0_1px_2px_rgba(0,0,0,0.28)]"
          >
            {name}
          </span>
          {typeof count === "number" ? (
            <span
              aria-hidden="true"
              className="shrink-0 rounded-md bg-black/15 px-1.5 py-px text-[11px] font-semibold tabular-nums leading-4 text-foreground/85 [text-shadow:0_1px_1px_rgba(0,0,0,0.18)] group-hover/title:bg-black/20 group-hover/title:text-foreground dark:bg-white/15 dark:group-hover/title:bg-white/20"
            >
              {count}
            </span>
          ) : null}
        </button>
      </h2>

      <div
        id={panelId}
        role="region"
        aria-label={name}
        hidden={collapsed}
      >
        {collapsed ? null : children}
      </div>
    </div>
  );
}
