/** 站点图标发现：纯函数（HTML 解析、静态回退、魔法头校验）。无 I/O。 */

export type SiteIconTier =
  | "apple-touch-icon"
  | "rel-icon"
  | "static-apple-touch"
  | "static-favicon";

export type DiscoveredIconRef = {
  href: string;
  tier: SiteIconTier;
  declaredSizes?: string;
  declaredType?: string;
};

const LINK_TAG_RE = /<link\b[^>]*>/gi;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;

function decodeHtmlAttr(raw: string): string {
  return raw
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&apos;/gi, "'");
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(tag)) !== null) {
    const name = match[1]!.toLowerCase();
    if (name === "link" || name.startsWith("<")) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeHtmlAttr(value);
  }
  return attrs;
}

function splitRelTokens(rel: string): string[] {
  return rel
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function classifyRel(relTokens: string[]): SiteIconTier | null {
  if (
    relTokens.includes("apple-touch-icon") ||
    relTokens.includes("apple-touch-icon-precomposed")
  ) {
    return "apple-touch-icon";
  }
  // mask-icon 等也常作站点标，归入 rel-icon 档
  if (relTokens.some((t) => t === "icon" || t === "shortcut" || t.endsWith("icon"))) {
    // 避免把 stylesheet 等误收：必须显式含 icon
    if (relTokens.some((t) => t.includes("icon"))) {
      return "rel-icon";
    }
  }
  return null;
}

/** 将可能为相对的 href 解析为绝对 URL；失败返回 null。 */
export function resolveMaybeRelativeUrl(
  href: string,
  baseUrl: string,
): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  try {
    const absolute = new URL(trimmed, baseUrl);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return null;
    }
    if (absolute.username || absolute.password) {
      return null;
    }
    return absolute.href;
  } catch {
    return null;
  }
}

/**
 * 从 HTML 中按文档序提取 apple-touch 与 rel=icon 候选（尚未含静态路径）。
 * baseUrl 用于解析相对 href，通常为 Icon Source URL 或最终响应 URL。
 */
export function discoverIconRefsFromHtml(
  html: string,
  baseUrl: string,
): DiscoveredIconRef[] {
  const apple: DiscoveredIconRef[] = [];
  const relIcons: DiscoveredIconRef[] = [];
  LINK_TAG_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = LINK_TAG_RE.exec(html)) !== null) {
    const attrs = parseAttributes(tagMatch[0]!);
    const rel = attrs["rel"];
    const href = attrs["href"];
    if (!rel || !href) continue;
    const tier = classifyRel(splitRelTokens(rel));
    if (tier === null) continue;
    const absolute = resolveMaybeRelativeUrl(href, baseUrl);
    if (absolute === null) continue;
    const ref: DiscoveredIconRef = { href: absolute, tier };
    if (attrs["sizes"]) ref.declaredSizes = attrs["sizes"];
    if (attrs["type"]) ref.declaredType = attrs["type"];
    if (tier === "apple-touch-icon") apple.push(ref);
    else relIcons.push(ref);
  }
  return [...apple, ...relIcons];
}

/** Origin 级静态回退路径（链第 3 档）。 */
export function staticIconFallbackRefs(pageUrl: string): DiscoveredIconRef[] {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  return [
    {
      href: `${origin}/apple-touch-icon.png`,
      tier: "static-apple-touch",
    },
    {
      href: `${origin}/favicon.ico`,
      tier: "static-favicon",
    },
  ];
}

/**
 * 合并 HTML 发现与静态回退，按回退链排序并按 href 去重（保留首次出现的更高优先级）。
 */
export function mergeIconDiscovery(
  fromHtml: DiscoveredIconRef[],
  pageUrl: string,
): DiscoveredIconRef[] {
  const staticRefs = staticIconFallbackRefs(pageUrl);
  const seen = new Set<string>();
  const out: DiscoveredIconRef[] = [];
  for (const ref of [...fromHtml, ...staticRefs]) {
    if (seen.has(ref.href)) continue;
    seen.add(ref.href);
    out.push(ref);
  }
  return out;
}

export type ImageExt = ".jpg" | ".png" | ".gif" | ".webp" | ".ico" | ".svg";

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

/** 根据魔法头识别图片扩展名；无法识别返回 null。 */
export function detectImageExtension(bytes: Uint8Array): ImageExt | null {
  if (bytes.length < 4) {
    if (bytes.length > 0 && looksLikeSvg(bytes)) return ".svg";
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return ".jpg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return ".png";
  }
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return ".gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return ".webp";
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) {
    return ".ico";
  }
  if (looksLikeSvg(bytes)) {
    return ".svg";
  }
  return null;
}

export function mimeTypeForImageExt(ext: ImageExt): string {
  switch (ext) {
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".svg":
      return "image/svg+xml";
    default: {
      const _e: never = ext;
      return _e;
    }
  }
}

/** 将图片字节编码为 data URL（供 Resolve 内嵌预览）。 */
export function bytesToDataUrl(bytes: Uint8Array, ext: ImageExt): string {
  const mime = mimeTypeForImageExt(ext);
  // Node / bundler 提供 Buffer 时优先使用，避免大图展开 call stack
  if (typeof Buffer !== "undefined") {
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    for (let j = 0; j < slice.length; j += 1) {
      binary += String.fromCharCode(slice[j]!);
    }
  }
  if (typeof btoa !== "function") {
    throw new Error("当前环境无法编码 data URL");
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function isHttpOrHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

/** 判断 redirect 目标是否与起始 URL 同 host（hostname 大小写不敏感）。 */
export function isSameHost(fromUrl: string, toUrl: string): boolean {
  try {
    const a = new URL(fromUrl);
    const b = new URL(toUrl);
    return a.hostname.toLowerCase() === b.hostname.toLowerCase();
  } catch {
    return false;
  }
}
