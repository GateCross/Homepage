export type SearchableItem = {
  id: string;
  name: string;
  href?: string | undefined;
  target: string;
};

export function matchSearch<T extends SearchableItem>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    if (q === "" || item.name.toLowerCase().includes(q)) {
      seen.add(item.id);
      result.push(item);
    }
  }

  return result;
}
