/**
 * URL 规范化与判定。
 * 与后端稳定 ID 输入同一套规则：只接受绝对 http(s)、剥离 userinfo 与 hash、
 * 空路径补 `/`、省略默认端口，保证前后端对同一链接得到同一个身份串。
 */

const ABSOLUTE_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/** 规范化绝对 http(s) URL；非法或非 http(s) 返回 null。 */
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

export function isAbsoluteHttpUrl(value: string): boolean {
  return normalizeAbsoluteHttpUrl(value) !== null;
}
