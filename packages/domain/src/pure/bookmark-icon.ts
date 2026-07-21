export type BookmarkIconFallbackInput = {
  icon?: string | null | undefined;
  /** 保留入参以兼容调用方；不再参与图标回退。 */
  abbr?: string | null | undefined;
  name: string;
  iconAvailable?: boolean | undefined;
};

export type BookmarkIconFallbackResult =
  | { kind: "icon"; value: string }
  | { kind: "placeholder" };

/**
 * 书签图标回退：有可用 icon 标识则返回之，否则统一 Generic Icon Placeholder。
 * abbr / 首字母不再作为视觉回退（见 CONTEXT.md）。
 */
export function resolveBookmarkIconFallback(
  input: BookmarkIconFallbackInput,
): BookmarkIconFallbackResult {
  const icon =
    typeof input.icon === "string" ? input.icon.trim() : "";
  const iconAvailable = input.iconAvailable !== false;

  if (icon.length > 0 && iconAvailable) {
    return { kind: "icon", value: icon };
  }

  return { kind: "placeholder" };
}
