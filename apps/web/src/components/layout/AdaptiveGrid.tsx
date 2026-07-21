import { resolveColumns } from "@homepage/domain";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export const ADAPTIVE_GRID_UNBOUNDED_MAX_COLUMNS = Number.MAX_SAFE_INTEGER;

export const ADAPTIVE_GRID_DEFAULT_GAP_PX = 8;

export type AdaptiveGridProps = {

  minItemWidth: number;

  maxColumns: number;

  useEqualHeights?: boolean;
  children: ReactNode;
  className?: string;

  gap?: number;

  as?: "div" | "ul";
};

export function AdaptiveGrid({
  minItemWidth,
  maxColumns,
  useEqualHeights = false,
  children,
  className,
  gap = ADAPTIVE_GRID_DEFAULT_GAP_PX,
  as = "div",
}: AdaptiveGridProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | HTMLUListElement | null>(null);
  const [containerWidthPx, setContainerWidthPx] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      if (element) {
        setContainerWidthPx(element.clientWidth);
      }
      return;
    }

    const updateWidth = (width: number): void => {
      setContainerWidthPx((prev) => (prev === width ? prev : width));
    };

    updateWidth(element.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      // contentBoxSize 更精确；回退 contentRect
      const box = entry.contentBoxSize?.[0];
      const width =
        typeof box?.inlineSize === "number"
          ? box.inlineSize
          : entry.contentRect.width;
      updateWidth(width);
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const columns = useMemo(
    () => resolveColumns(maxColumns, containerWidthPx, minItemWidth),
    [maxColumns, containerWidthPx, minItemWidth],
  );

  const safeGap =
    typeof gap === "number" && Number.isFinite(gap) && gap >= 0 ? gap : 0;

  const style = useMemo((): CSSProperties => {
    return {
      display: "grid",
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gap: `${safeGap}px`,
      alignItems: useEqualHeights ? "stretch" : "start",
      width: "100%",
      minWidth: 0,
      maxWidth: "100%",
      boxSizing: "border-box",
      listStyle: as === "ul" ? "none" : undefined,
      padding: as === "ul" ? 0 : undefined,
      margin: as === "ul" ? 0 : undefined,
    };
  }, [as, columns, safeGap, useEqualHeights]);

  const sharedProps = {
    ref: containerRef as React.RefCallback<HTMLElement> &
      React.RefObject<HTMLDivElement | HTMLUListElement | null>,
    "data-slot": "adaptive-grid" as const,
    "data-columns": columns,
    "data-equal-heights": useEqualHeights ? ("true" as const) : ("false" as const),
    "data-min-item-width": minItemWidth,
    "data-max-columns": maxColumns,
    className: cn(
      "w-full min-w-0 max-w-full overflow-x-clip",
      useEqualHeights && "[&>*]:h-full [&>*]:min-h-0",
      className,
    ),
    style,
    children,
  };

  // 分标签渲染，避免多态 ref 复杂化
  if (as === "ul") {
    return (
      <ul
        ref={containerRef as React.RefObject<HTMLUListElement | null>}
        data-slot={sharedProps["data-slot"]}
        data-columns={sharedProps["data-columns"]}
        data-equal-heights={sharedProps["data-equal-heights"]}
        data-min-item-width={sharedProps["data-min-item-width"]}
        data-max-columns={sharedProps["data-max-columns"]}
        className={sharedProps.className}
        style={sharedProps.style}
      >
        {children}
      </ul>
    );
  }

  return (
    <div
      ref={containerRef as React.RefObject<HTMLDivElement | null>}
      data-slot={sharedProps["data-slot"]}
      data-columns={sharedProps["data-columns"]}
      data-equal-heights={sharedProps["data-equal-heights"]}
      data-min-item-width={sharedProps["data-min-item-width"]}
      data-max-columns={sharedProps["data-max-columns"]}
      className={sharedProps.className}
      style={sharedProps.style}
    >
      {children}
    </div>
  );
}
