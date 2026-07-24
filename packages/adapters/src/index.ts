import { DOMAIN_PACKAGE_NAME } from "@homepage/domain";

export const ADAPTERS_PACKAGE_NAME = "@homepage/adapters" as const;

export const ADAPTERS_BOUNDARY = {
  packageName: ADAPTERS_PACKAGE_NAME,
  dependsOn: [DOMAIN_PACKAGE_NAME] as const,
  role: "external-protocol-to-unified-metrics",
} as const;

export { DOMAIN_PACKAGE_NAME };

export type {
  AdapterRunInput,
  AdapterSecrets,
  RunServiceWidgetInput,
  ServiceWidgetAdapter,
} from "./types.js";

export {
  INVALID_WIDGET_RESULT_ERROR,
  UNSUPPORTED_WIDGET_ERROR,
  isMetricWellFormed,
  parseServiceWidgetResult,
  unsupportedWidgetResult,
  validateSuccessMetrics,
} from "./validate.js";

export {
  getServiceWidgetAdapter,
  isRegisteredServiceWidgetType,
  listRegisteredServiceWidgetTypes,
  registerServiceWidgetAdapter,
  runServiceWidget,
} from "./registry.js";

export {
  AdapterLocalError,
  ADAPTER_LARGE_RESPONSE_MAX_BYTES,
  DEFAULT_ADAPTER_INSECURE_TLS,
  DEFAULT_ADAPTER_RESPONSE_MAX_BYTES,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  adapterFetch,
  getAdapterFetch,
  getSetCookieLines,
  joinBaseUrl,
  readJsonBody,
  setAdapterFetch,
  toLocalErrorMessage,
} from "./http.js";
export type { AdapterRequestOptions, FetchLike } from "./http.js";

export {
  coerceFiniteNumber,
  formatDurationSeconds,
  formatPercentValue,
  roundTo,
  scaleByteRate,
  scaleBytes,
} from "./format.js";
export type { ScaledUnitValue } from "./format.js";

export {
  QBITTORRENT_DOWNLOAD_METRIC_ID,
  QBITTORRENT_UPLOAD_METRIC_ID,
  QBITTORRENT_DOWNLOADING_COUNT_METRIC_ID,
  QBITTORRENT_SEEDING_COUNT_METRIC_ID,
  buildQbittorrentMetrics,
  countTorrentStates,
  extractSidFromSetCookieLines,
  fetchQbittorrentTransferMetrics,
  fetchTorrentsInfoRaw,
  fetchTransferInfoRaw,
  loginQbittorrent,
  qbittorrentAdapter,
  transferInfoToMetrics,
  transferInfoToRates,
} from "./qbittorrent.js";
export type { QbittorrentAuth, QbittorrentFetchDeps } from "./qbittorrent.js";

export {
  TRANSMISSION_DOWNLOAD_METRIC_ID,
  TRANSMISSION_UPLOAD_METRIC_ID,
  TRANSMISSION_DOWNLOADING_COUNT_METRIC_ID,
  TRANSMISSION_SEEDING_COUNT_METRIC_ID,
  buildTransmissionMetrics,
  callTransmissionRpc,
  countTransmissionTorrents,
  fetchTransmissionMetrics,
  parseSessionStats,
  transmissionAdapter,
  transmissionRpc,
} from "./transmission.js";
export type {
  TransmissionAuth,
  TransmissionFetchDeps,
} from "./transmission.js";

export {
  EMBY_SESSIONS_TOTAL_METRIC_ID,
  EMBY_MOVIES_METRIC_ID,
  EMBY_SERIES_METRIC_ID,
  EMBY_EPISODES_METRIC_ID,
  EMBY_SONGS_METRIC_ID,
  EMBY_SESSION_SUMMARY_LIMIT,
  convertEmbyCounts,
  convertEmbySessions,
  embyAdapter,
  fetchEmbyCounts,
  fetchEmbySessions,
  fetchEmbyWidgetData,
  isNowPlayingSession,
  parseEmbyOptions,
  readEmbyApiKey,
  sessionToSummary,
} from "./emby.js";
export type { EmbyFetchDeps, EmbyWidgetOptions } from "./emby.js";

export {
  CUSTOM_API_FORMATS,
  customApiAdapter,
  fetchCustomApiMetrics,
  formatMappingValue,
  getValueByDotPath,
  mapCustomApiResponse,
  normalizeMappingEntry,
  parseCustomApiOptions,
  parseDotPath,
  resolveMappingPath,
} from "./customapi.js";
export type {
  CustomApiFetchDeps,
  CustomApiFormat,
  CustomApiMapping,
  CustomApiOptions,
} from "./customapi.js";

export {
  IMMICH_USERS_METRIC_ID,
  IMMICH_PHOTOS_METRIC_ID,
  IMMICH_VIDEOS_METRIC_ID,
  IMMICH_STORAGE_METRIC_ID,
  convertImmichStatistics,
  fetchImmichStatistics,
  immichAdapter,
  parseImmichOptions,
  readImmichApiKey,
} from "./immich.js";
export type { ImmichFetchDeps, ImmichWidgetOptions } from "./immich.js";

export {
  CADDY_UPSTREAMS_METRIC_ID,
  CADDY_REQUESTS_METRIC_ID,
  CADDY_REQUESTS_FAILED_METRIC_ID,
  convertCaddyUpstreams,
  fetchCaddyUpstreams,
  caddyAdapter,
  parseCaddyOptions,
} from "./caddy.js";
export type { CaddyFetchDeps, CaddyWidgetOptions } from "./caddy.js";
