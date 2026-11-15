import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean | undefined;
};

export type SelectProps = {
  value?: string | number | undefined;
  defaultValue?: string | number | undefined;
  onChange?:
    | ((e: { target: { value: string; name?: string | undefined } }) => void)
    | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  triggerClassName?: string | undefined;
  contentClassName?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  options?: SelectOption[] | undefined;
  children?: React.ReactNode | undefined;
  "aria-label"?: string | undefined;
};

/** 从 children 中提取 option 标签内容，兼容原生 select 的用法 */
function parseOptions(
  optionsProp?: SelectOption[],
  children?: React.ReactNode,
): SelectOption[] {
  if (optionsProp && optionsProp.length > 0) {
    return optionsProp;
  }
  const result: SelectOption[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child)) {
      const props = child.props as {
        value?: string | number | undefined;
        children?: React.ReactNode | undefined;
        disabled?: boolean | undefined;
      };
      if (props.value !== undefined) {
        result.push({
          value: String(props.value),
          label: props.children ?? String(props.value),
          disabled: props.disabled,
        });
      }
    }
  });
  return result;
}

/**
 * 现代化下拉选择组件：基于 Radix DropdownMenu 构建，
 * 替换原生粗糙的 select 控件，支持圆角、阴影、选中对勾与毛玻璃浮层。
 */
function Select({
  value,
  defaultValue,
  onChange,
  onValueChange,
  disabled,
  placeholder = "请选择...",
  className,
  triggerClassName,
  contentClassName,
  name,
  id,
  options: optionsProp,
  children,
  ...props
}: SelectProps): React.JSX.Element {
  const options = parseOptions(optionsProp, children);
  const currentStr =
    value !== undefined
      ? String(value)
      : defaultValue !== undefined
        ? String(defaultValue)
        : "";

  const selectedOption = options.find((opt) => opt.value === currentStr);

  const handleSelect = (optValue: string): void => {
    onValueChange?.(optValue);
    onChange?.({
      target: {
        value: optValue,
        name,
      },
    });
  };

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild disabled={disabled ?? false}>
        <button
          type="button"
          id={id}
          data-slot="select"
          disabled={disabled ?? false}
          aria-label={props["aria-label"]}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background/80 px-3 py-2 text-sm text-foreground shadow-xs transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName,
            className,
          )}
        >
          <span
            className={cn(
              "mr-2 flex-1 truncate text-left",
              !selectedOption && "text-muted-foreground",
            )}
          >
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-60 transition-transform duration-200" />
        </button>
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          data-slot="select-content"
          sideOffset={4}
          align="start"
          className={cn(
            "glass-panel z-[70] max-h-64 min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md animate-in fade-in-0 zoom-in-95",
            contentClassName,
          )}
        >
          {options.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              暂无可选选项
            </div>
          ) : (
            options.map((opt) => {
              const isSelected = opt.value === currentStr;
              return (
                <DropdownMenuPrimitive.Item
                  key={opt.value}
                  disabled={opt.disabled ?? false}
                  onSelect={() => handleSelect(opt.value)}
                  className={cn(
                    "relative flex cursor-pointer select-none items-center justify-between rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors hover:bg-muted/70 focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                    isSelected &&
                      "bg-accent/60 font-medium text-accent-foreground",
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected ? (
                    <Check className="ml-2 size-4 shrink-0 text-primary" />
                  ) : null}
                </DropdownMenuPrimitive.Item>
              );
            })
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export { Select };
