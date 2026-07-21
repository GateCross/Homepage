/** 随前端构建分发的默认站点图标（apps/web/public） */
export const DEFAULT_BRAND_FAVICON = "/favicon.svg" as const;
export const DEFAULT_APPLE_TOUCH_ICON = "/apple-touch-icon.png" as const;

/**
 * 可在 <img> / <link rel=icon> 中展示的资源路径。
 * 允许：http(s)、/images/…、/icons/…、以及 web public 根路径（如 /favicon.svg）。
 */
export function isDisplayableAssetPath(
  value: string | undefined | null,
): value is string {
  if (value === null || value === undefined) return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (v.startsWith("http://") || v.startsWith("https://")) return true;
  if (!v.startsWith("/") || v.startsWith("//")) return false;
  if (v.includes("..") || v.includes("\\")) return false;
  return true;
}

export function resolveBrandFavicon(src: string | undefined | null): string {
  return isDisplayableAssetPath(src) ? src.trim() : DEFAULT_BRAND_FAVICON;
}
