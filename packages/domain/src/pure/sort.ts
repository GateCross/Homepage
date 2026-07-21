export type Weightable = {
  weight?: number | undefined;
};

export function sortServicesStable<T extends Weightable>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aw = a.item.weight;
      const bw = b.item.weight;
      const aHas = typeof aw === "number" && Number.isFinite(aw);
      const bHas = typeof bw === "number" && Number.isFinite(bw);
      if (aHas && bHas && aw !== bw) {
        return (bw as number) - (aw as number);
      }
      if (aHas && !bHas) {
        return -1;
      }
      if (!aHas && bHas) {
        return 1;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}
