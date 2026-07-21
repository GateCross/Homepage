import {
  useCallback,
  useState,
  type DragEvent,
  type JSX,
  type ReactNode,
} from "react";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { moveItem } from "@/lib/config-editor/validation";
import { cn } from "@/lib/utils";

export type ReorderDragState = {
  from: number;
  over: number | null;
};

export type UseReorderDragOptions<T> = {
  items: readonly T[];
  onReorder: (next: T[]) => void;
  disabled?: boolean | undefined;
};

export type UseReorderDragResult = {
  drag: ReorderDragState | null;
  getHandleProps: (index: number) => {
    draggable: boolean;
    onDragStart: (event: DragEvent) => void;
    onDragEnd: () => void;
  };
  getRowProps: (index: number) => {
    onDragOver: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
    onDragLeave: () => void;
    "data-dragging"?: true;
    "data-drop-target"?: true;
  };
};

export function useReorderDrag<T>({
  items,
  onReorder,
  disabled,
}: UseReorderDragOptions<T>): UseReorderDragResult {
  const [drag, setDrag] = useState<ReorderDragState | null>(null);

  const getHandleProps = useCallback(
    (index: number) => ({
      draggable: !disabled && items.length > 1,
      onDragStart: (event: DragEvent) => {
        if (disabled || items.length <= 1) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
        // 部分浏览器需要一点延迟才应用拖拽样式
        requestAnimationFrame(() => {
          setDrag({ from: index, over: index });
        });
      },
      onDragEnd: () => {
        setDrag(null);
      },
    }),
    [disabled, items.length],
  );

  const getRowProps = useCallback(
    (index: number) => ({
      onDragOver: (event: DragEvent) => {
        if (disabled || drag === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (drag.over !== index) {
          setDrag({ from: drag.from, over: index });
        }
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        if (disabled || drag === null) return;
        const next = moveItem([...items], drag.from, index);
        setDrag(null);
        if (next !== items && next.some((v, i) => v !== items[i])) {
          onReorder(next);
        }
      },
      onDragLeave: () => {
        // 离开行时不立刻清 over，避免闪烁；drop/end 会收尾
      },
      ...(drag?.from === index ? ({ "data-dragging": true } as const) : {}),
      ...(drag !== null && drag.over === index && drag.from !== index
        ? ({ "data-drop-target": true } as const)
        : {}),
    }),
    [disabled, drag, items, onReorder],
  );

  return { drag, getHandleProps, getRowProps };
}

export function IconActionButton({
  label,
  onClick,
  disabled,
  variant = "ghost",
  tone = "default",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  variant?: "ghost" | "outline" | "default" | undefined;
  tone?: "default" | "danger" | undefined;
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant={variant}
          disabled={disabled}
          aria-label={label}
          className={cn(
            "shrink-0 text-muted-foreground",
            tone === "danger" &&
              "hover:bg-destructive/10 hover:text-destructive",
          )}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function DragHandle({
  disabled,
  ...props
}: {
  disabled?: boolean | undefined;
  draggable?: boolean | undefined;
  onDragStart?: ((event: DragEvent) => void) | undefined;
  onDragEnd?: (() => void) | undefined;
  className?: string | undefined;
}): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="拖拽排序"
      title="拖拽排序"
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex size-8 shrink-0 select-none items-center justify-center rounded-md text-muted-foreground/70 transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "cursor-grab hover:bg-muted hover:text-foreground active:cursor-grabbing",
        props.className,
      )}
      draggable={!disabled && props.draggable}
      onDragStart={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        props.onDragStart?.(event);
      }}
      onDragEnd={props.onDragEnd}
      onKeyDown={(event) => {
        // 仅作可聚焦提示，排序靠拖拽
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
        }
      }}
    >
      <GripVertical className="size-4" aria-hidden="true" />
    </div>
  );
}

export function EditorKeywordTags({
  tags,
  dangerTag,
}: {
  tags: string[];
  dangerTag?: string | undefined;
}): JSX.Element | null {
  if (tags.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {tags.slice(0, 4).map((tag) => (
        <span
          key={tag}
          className={cn(
            "max-w-[14rem] truncate rounded-md px-1.5 py-0.5 text-[11px] leading-none",
            tag === dangerTag
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              : "bg-muted/80 text-muted-foreground",
          )}
          title={tag}
        >
          {tag}
        </span>
      ))}
      {tags.length > 4 ? (
        <span className="rounded-md bg-muted/80 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
          +{tags.length - 4}
        </span>
      ) : null}
    </div>
  );
}

export function EditorListRow({
  icon,
  title,
  subtitle,
  tags,
  hasError,
  disabled,
  dragHandleProps,
  onEdit,
  onDelete,
  rowProps,
  className,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  tags?: string[] | undefined;
  hasError?: boolean | undefined;
  disabled?: boolean | undefined;
  dragHandleProps: ReturnType<UseReorderDragResult["getHandleProps"]>;
  onEdit: () => void;
  onDelete: () => void;
  rowProps: ReturnType<UseReorderDragResult["getRowProps"]>;
  className?: string | undefined;
}): JSX.Element {
  return (
    <li
      {...rowProps}
      className={cn(
        "group flex items-center gap-1.5 border-b border-border/40 px-2 py-2 last:border-b-0 sm:gap-2 sm:px-2.5",
        "bg-card/30 transition-[background-color,opacity,box-shadow] duration-150",
        "hover:bg-muted/40",
        rowProps["data-dragging"] && "opacity-45",
        rowProps["data-drop-target"] &&
          "bg-primary/5 shadow-[inset_0_2px_0_0_var(--color-primary)]",
        hasError && "bg-destructive/[0.04]",
        className,
      )}
    >
      <DragHandle disabled={disabled} {...dragHandleProps} />
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium leading-none">
            {title}
          </span>
          {hasError ? (
            <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              有错误
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        ) : null}
        {tags ? <EditorKeywordTags tags={tags} dangerTag="已隐藏" /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconActionButton label="编辑" disabled={disabled} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </IconActionButton>
        <IconActionButton
          label="删除"
          disabled={disabled}
          tone="danger"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </IconActionButton>
      </div>
    </li>
  );
}

export function EditorGroupCard({
  title,
  countLabel,
  hasError,
  errorText,
  disabled,
  dragHandleProps,
  rowProps,
  onEdit,
  onDelete,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  countLabel: string;
  hasError?: boolean | undefined;
  errorText?: string | undefined;
  disabled?: boolean | undefined;
  dragHandleProps: ReturnType<UseReorderDragResult["getHandleProps"]>;
  rowProps: ReturnType<UseReorderDragResult["getRowProps"]>;
  onEdit: () => void;
  onDelete: () => void;
  onAdd: () => void;
  addLabel: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      {...rowProps}
      className={cn(
        "overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-sm backdrop-blur-sm transition-[opacity,box-shadow,border-color] duration-150",
        rowProps["data-dragging"] && "opacity-50",
        rowProps["data-drop-target"] &&
          "border-primary/50 ring-1 ring-primary/30",
        hasError && "border-destructive/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 bg-muted/25 px-2 py-2 sm:gap-2 sm:px-3">
        <DragHandle disabled={disabled} {...dragHandleProps} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold tracking-tight">
              {title}
            </h3>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {countLabel}
            </span>
            {hasError ? (
              <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                有错误
              </span>
            ) : null}
          </div>
          {errorText ? (
            <p className="mt-0.5 text-xs text-destructive">{errorText}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconActionButton
            label={addLabel}
            disabled={disabled}
            variant="outline"
            onClick={onAdd}
          >
            <Plus className="size-3.5" />
          </IconActionButton>
          <IconActionButton label="编辑分组" disabled={disabled} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </IconActionButton>
          <IconActionButton
            label="删除分组"
            disabled={disabled}
            tone="danger"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </IconActionButton>
        </div>
      </div>
      <ul className="divide-y-0">{children}</ul>
    </section>
  );
}
