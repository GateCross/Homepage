export const SERVICE_MIN_ITEM_WIDTH_PX = 240 as const;

export const BOOKMARK_MIN_ITEM_WIDTH_PX = 160 as const;

export function resolveColumns(
  maxColumns: number,
  containerWidthPx: number,
  minItemWidthPx: number,
): number {
  const safeMinWidth =
    typeof minItemWidthPx === "number" &&
    Number.isFinite(minItemWidthPx) &&
    minItemWidthPx > 0
      ? minItemWidthPx
      : 1;

  const safeWidth =
    typeof containerWidthPx === "number" &&
    Number.isFinite(containerWidthPx) &&
    containerWidthPx > 0
      ? containerWidthPx
      : 0;

  const capacity = Math.max(1, Math.floor(safeWidth / safeMinWidth));
  const max = Math.max(
    1,
    Math.floor(
      typeof maxColumns === "number" && Number.isFinite(maxColumns)
        ? maxColumns
        : 1,
    ),
  );

  return Math.max(1, Math.min(max, capacity));
}
