import * as React from "react";

import { cn } from "@/lib/utils";

export type SelectProps = React.ComponentProps<"select">;

/** 原生 select：补齐深色模式下 option 的前景/背景，避免白底浅字 */
function Select({ className, children, ...props }: SelectProps): React.JSX.Element {
  return (
    <select
      data-slot="select"
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        "[&>option]:bg-popover [&>option]:text-popover-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { Select };
