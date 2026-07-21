/** 领域基础纯函数导出。 排序、搜索、网格、URL 判定、书签图标回退、 主题、探测分类、密钥插值、标题规范化、百分比夹取。 */
export { isAbsoluteHttpUrl } from "./url.js";
export { sortServicesStable, type Weightable } from "./sort.js";
export { matchSearch, type SearchableItem } from "./search.js";
export {
  BOOKMARK_MIN_ITEM_WIDTH_PX,
  SERVICE_MIN_ITEM_WIDTH_PX,
  resolveColumns,
} from "./grid.js";
export {
  resolveBookmarkIconFallback,
  type BookmarkIconFallbackInput,
  type BookmarkIconFallbackResult,
} from "./bookmark-icon.js";

export {
  bytesToDataUrl,
  detectImageExtension,
  discoverIconRefsFromHtml,
  isHttpOrHttpsUrl,
  isSameHost,
  mergeIconDiscovery,
  mimeTypeForImageExt,
  resolveMaybeRelativeUrl,
  staticIconFallbackRefs,
  type DiscoveredIconRef,
  type ImageExt,
  type SiteIconTier,
} from "./site-icon.js";

export {
  parseThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme.js";

export {
  classifyHttpProbe,
  isValidDockerState,
  isValidHttpProbeState,
  matchesExpected,
  normalizeExpectedStatus,
  type NetworkProbeResult,
} from "./probe.js";

export {
  WHOLE_ENV_PLACEHOLDER_RE,
  interpolateEnvWholeValue,
  isWholeEnvPlaceholder,
  type InterpolateEnvResult,
} from "./env.js";

export {
  DEFAULT_DASHBOARD_TITLE,
  normalizeTitle,
} from "./title.js";

export { clampPercent } from "./percent.js";
