/** 前端纯函数出口：无 I/O、无 React 依赖，可单独测试。 */
export {
  BOOKMARK_MIN_ITEM_WIDTH_PX,
  SERVICE_MIN_ITEM_WIDTH_PX,
  resolveColumns,
} from "./grid";
export { matchSearch, type SearchableItem } from "./search";
export { parseThemeMode, type ResolvedTheme, type ThemeMode } from "./theme";
export { DEFAULT_DASHBOARD_TITLE, normalizeTitle } from "./title";
export { isAbsoluteHttpUrl, normalizeAbsoluteHttpUrl } from "./url";
