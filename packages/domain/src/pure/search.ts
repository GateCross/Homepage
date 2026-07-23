export type SearchableItem = {
  id: string;
  name: string;
  href?: string | undefined;
  target: string;
  /** 可选描述，参与搜索 */
  description?: string | undefined;
};

/** 从绝对/协议相对 URL 提取 hostname（不含端口与 userinfo）；不依赖 DOM/Node URL。 */
function extractHost(href: string | undefined): string {
  if (href === undefined) {
    return "";
  }
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return "";
  }
  // 仅解析带 scheme:// 或 // 的地址；相对路径无 host
  const match = trimmed.match(/^(?:[a-zA-Z][a-zA-Z\d+\-.]*:)?\/\/([^/?#]+)/);
  if (match === null || match[1] === undefined) {
    return "";
  }
  let authority = match[1];
  // 去掉 userinfo
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    authority = authority.slice(at + 1);
  }
  // IPv6: [2001:db8::1]:443
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end !== -1) {
      return authority.slice(1, end).toLowerCase();
    }
  }
  // host:port
  const colon = authority.indexOf(":");
  if (colon !== -1) {
    authority = authority.slice(0, colon);
  }
  return authority.toLowerCase();
}

function itemMatchesQuery<T extends SearchableItem>(
  item: T,
  q: string,
): boolean {
  if (item.name.toLowerCase().includes(q)) {
    return true;
  }
  const description = item.description?.trim().toLowerCase();
  if (description !== undefined && description.length > 0 && description.includes(q)) {
    return true;
  }
  if (item.href !== undefined && item.href.toLowerCase().includes(q)) {
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
