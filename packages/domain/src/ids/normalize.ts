const ABSOLUTE_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 规范化绝对 http(s) URL，作为稳定身份输入。
 * - 剥离 userinfo（用户名/密码不得进入身份）
 * - 剥离 hash；保留 pathname 与 search
 * - 空路径规范为 `/`
 * - 非法或非 http(s) 返回 `null`
 */
export function normalizeAbsoluteHttpUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!ABSOLUTE_HTTP_PROTOCOLS.has(url.protocol)) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) {
    return null;
  }

  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port =
    url.port !== "" && url.port !== defaultPort ? `:${url.port}` : "";

  const pathname = url.pathname === "" ? "/" : url.pathname;
  // 不包含 hash；search 按 URL 解析结果保留（含前导 ?）
  return `${url.protocol}//${hostname}${port}${pathname}${url.search}`;
}

export function normalizeDiskPathIdentity(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }

  let path = trimmed.replaceAll("\\", "/");
  // 折叠 //（保留 UNC 风格的开头 // 为单段逻辑：先标记再折叠）
  const unc = path.startsWith("//");
  path = path.replace(/\/{2,}/g, "/");
  if (unc) {
    path = `/${path}`; // 折叠后补回一档，得到 //host/... 的双斜杠开头
    // 上式在 path 已以 / 开头时得到 //...
  }

  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path;
}

export function normalizeDiskPathSet(
  paths: readonly string[],
): readonly string[] {
  const set = new Set<string>();
  for (const item of paths) {
    const normalized = normalizeDiskPathIdentity(item);
    if (normalized.length > 0) {
      set.add(normalized);
    }
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function normalizeTypeToken(raw: string): string {
  return raw.trim().toLowerCase();
}
