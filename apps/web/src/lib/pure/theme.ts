/** 主题模式解析：非法值一律回落 system。 */

export type ThemeMode = "system" | "light" | "dark";

export type ResolvedTheme = "light" | "dark";

export function parseThemeMode(raw: unknown): ThemeMode {
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }
  return "system";
}
