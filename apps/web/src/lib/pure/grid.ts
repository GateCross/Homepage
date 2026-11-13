/** 自适应网格列数计算：按容器宽度与最小卡片宽度取容量，再受配置的最大列数约束。 */

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

  // 容器宽度不足一张卡片时仍保留 1 列，避免 0 列导致的空白
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
