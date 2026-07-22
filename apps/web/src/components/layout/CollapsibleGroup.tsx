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
      <h2 className="mb-3">
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
            "group/title -ml-1.5 inline-flex max-w-full items-center gap-2 rounded-xl px-2 py-1",
            "text-left transition-colors duration-150",
            "hover:bg-white/12 dark:hover:bg-white/6",
            "active:bg-white/16 dark:active:bg-white/10",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
          )}
        >
          <span
            aria-hidden="true"
            className="inline-flex size-4 shrink-0 items-center justify-center text-foreground/70 transition-transform duration-200 ease-out will-change-transform [text-shadow:0_1px_2px_rgba(0,0,0,0.28)] group-hover/title:text-foreground"
            style={{
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            }}
          >
            <ChevronRight className="size-4" strokeWidth={2.4} />
          </span>
          <span
            aria-hidden="true"
            className="h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-primary to-primary/55 shadow-[0_0_8px_rgba(56,140,220,0.35)]"
          />
          <span
            aria-hidden="true"
            className="min-w-0 truncate text-[0.95rem] font-semibold tracking-tight text-foreground [text-shadow:0_1px_2px_rgba(0,0,0,0.28)] sm:text-base"
          >
            {name}
          </span>
          {typeof count === "number" ? (
            <span
              aria-hidden="true"
              className="shrink-0 rounded-full border border-white/15 bg-black/12 px-2 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-foreground/80 backdrop-blur-sm [text-shadow:0_1px_1px_rgba(0,0,0,0.18)] group-hover/title:border-white/25 group-hover/title:bg-black/18 group-hover/title:text-foreground dark:border-white/12 dark:bg-white/10 dark:group-hover/title:bg-white/16"
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
