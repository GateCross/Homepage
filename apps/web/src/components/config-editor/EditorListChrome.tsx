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

/** 页签页头：标题 + 说明 + 右侧操作，压住内容区顶部 */
export function EditorPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
      <div className="min-w-0">
        <h3 className="text-base font-semibold leading-tight">{title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

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

function DragHandle({
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
      aria-disabled={disabled ? true : undefined}
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

function EditorKeywordTags({
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
              ? "bg-status-warning-bg text-status-warning"
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
  host,
  tags,
  hasError,
  disabled,
  dragHandleProps,
  onEdit,
  onDelete,
  rowProps,
  className,
  editing,
}: {
  icon: ReactNode;
  title: string;
  /** 名称下方的次要文字（如描述） */
  subtitle?: ReactNode;
  /** 地址列：来自条目 href 的主机，等宽字体弱化展示 */
  host?: string | undefined;
  tags?: string[] | undefined;
  hasError?: boolean | undefined;
  disabled?: boolean | undefined;
  dragHandleProps: ReturnType<UseReorderDragResult["getHandleProps"]>;
  onEdit: () => void;
  onDelete: () => void;
  rowProps: ReturnType<UseReorderDragResult["getRowProps"]>;
  className?: string | undefined;
  /** 该条目正被编辑（编辑弹窗打开时的描边提示） */
  editing?: boolean | undefined;
}): JSX.Element {
  return (
    <li
      {...rowProps}
      className={cn(
        // py-2：标题/地址行与卡片上下边框保持呼吸空隙，文字块会撑起行高
        "group relative flex flex-col rounded-lg border border-border/50 bg-card/60 py-2 shadow-xs backdrop-blur-sm",
        "transition-[background-color,opacity,box-shadow,border-color] duration-150",
        editing
          ? "border-primary/40 ring-1 ring-primary/30"
          : "hover:border-border hover:bg-card/85",
        rowProps["data-dragging"] && "opacity-50",
        rowProps["data-drop-target"] &&
          "border-primary/50 ring-1 ring-primary/30",
        hasError && "border-destructive/40",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <DragHandle disabled={disabled} {...dragHandleProps} />
        <div className="shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold leading-tight">
              {title}
            </span>
            {hasError ? (
              <span className="shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                有错误
              </span>
            ) : null}
          </div>
          {subtitle ? (
            <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
          {host || (tags && tags.length > 0) ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              {host ? (
                <span
                  title={host}
                  className="truncate font-mono text-[11px] leading-none text-muted-foreground"
                >
                  {host}
                </span>
              ) : null}
              {tags && tags.length > 0 ? (
                <EditorKeywordTags tags={tags} dangerTag="已隐藏" />
              ) : null}
            </div>
          ) : null}
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
  nameEditor,
  contentClassName,
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
  /** 存在时替换标题区（分组改名内嵌编辑态），并隐藏右上角操作 */
  nameEditor?: ReactNode;
  /** 内容容器追加类（如卡片网格的列定义） */
  contentClassName?: string | undefined;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      {...rowProps}
      className={cn(
        "rounded-xl border border-border/60 bg-card/40 shadow-sm backdrop-blur-sm transition-[opacity,box-shadow,border-color] duration-150",
        rowProps["data-dragging"] && "opacity-50",
        rowProps["data-drop-target"] &&
          "border-primary/50 ring-1 ring-primary/30",
        hasError && "border-destructive/40",
      )}
    >
      {/* 分组头吸顶：滚动时钉在内容区顶部，实底遮住从下方穿过的行，避免标题被边缘截断 */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 rounded-t-[calc(var(--radius-xl)-1px)] border-b border-border/50 bg-muted px-2 py-2 sm:gap-2 sm:px-3">
        <DragHandle disabled={disabled || Boolean(nameEditor)} {...dragHandleProps} />
        {nameEditor ? (
          <div className="min-w-0 flex-1">{nameEditor}</div>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h4 className="truncate text-sm font-semibold tracking-tight">
                  {title}
                </h4>
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums leading-none text-muted-foreground">
                  {countLabel}
                </span>
                {hasError ? (
                  <span className="shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
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
          </>
        )}
      </div>
      <ul className={cn("grid content-start gap-2 p-2", contentClassName)}>
        {children}
      </ul>
    </section>
  );
}
