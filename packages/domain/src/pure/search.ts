export type SearchableItem = {
  id: string;
  name: string;
  href?: string | undefined;
  target: string;
  /** 可选描述，参与搜索 */
  description?: string | undefined;
};

/** 从绝对或协议相对 URL 提取 hostname（不含端口和 userinfo）。 */
function extractHost(href: string | undefined): string {
  const trimmed = href?.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed.startsWith("//") ? `http:${trimmed}` : trimmed).hostname;
  } catch {
    return "";
  }
}

function itemMatchesQuery<T extends SearchableItem>(
  item: T,
  q: string,
): boolean {
  if (item.name.toLowerCase().includes(q)) {
    return true;
  }
  const description = item.description?.trim().toLowerCase();
  if (description?.includes(q)) {
    return true;
  }
  if (item.href?.toLowerCase().includes(q)) {
    return true;
  }
  const host = extractHost(item.href);
  if (host.length > 0 && host.includes(q)) {
    return true;
  }
  return false;
}

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
    if (q === "" || itemMatchesQuery(item, q)) {
      seen.add(item.id);
      result.push(item);
    }
  }

  return result;
}
