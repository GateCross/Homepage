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
            "group/title -ml-1.5 inline-flex max-w-full items-center gap-2 rounded-md px-2 py-1",
            "text-left transition-colors duration-150",
            "hover:bg-white/12 dark:hover:bg-white/6",
            "active:bg-white/16 dark:active:bg-white/10",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
          )}
        >
          <span
            aria-hidden="true"
            className="inline-flex size-4 shrink-0 items-center justify-center text-foreground/70 transition-transform duration-200 ease-out will-change-transform group-hover/title:text-foreground"
            style={{
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
            }}
          >
            <ChevronRight className="size-4" />
          </span>
          <span
            aria-hidden="true"
            className="min-w-0 truncate text-[0.95rem] font-semibold text-foreground sm:text-base"
          >
            {name}
          </span>
          {typeof count === "number" ? (
            <span
              aria-hidden="true"
              className="shrink-0 text-[11px] font-medium tabular-nums leading-none text-foreground/60"
            >
              {count}
            </span>
          ) : null}
        </button>
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
