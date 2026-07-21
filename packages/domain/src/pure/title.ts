export const DEFAULT_DASHBOARD_TITLE = "首页" as const;

export function normalizeTitle(title: unknown): string {
  if (typeof title === "string") {
    const trimmed = title.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return DEFAULT_DASHBOARD_TITLE;
}
