/** 前端契约汇总出口。类型与后端 Go `internal/domain` 一一对应。 */
export type {
  ErrorEnvelope,
  Metric,
  MetricStatus,
  PublicError,
  StatusRange,
} from "./common";

export {
  API_ERROR_STATUS_BY_CODE,
  API_JSON_CONTENT_TYPE,
  ApiErrorCode,
  ApiHttpStatus,
  type ApiErrorCodeValue,
  type ApiHttpStatusCode,
} from "./http-status";

export type {
  BookmarkGroup,
  BookmarkGroupItem,
  BookmarkItemError,
  InfoWidgetConfig,
  LayoutGroup,
  NormalizedBookmark,
  NormalizedConfig,
  NormalizedService,
  NormalizedSettings,
  ServiceDockerRef,
  ServiceGroup,
  ServiceGroupItem,
  ServiceHttpProbe,
  ServiceItemError,
  ServiceWidgetRef,
} from "./config";

export type {
  DockerBatchItem,
  DockerBatchStatusResponse,
  DockerContainerSummary,
  DockerContainersResponse,
  DockerHealth,
  DockerResourceStats,
  DockerState,
  DockerStatusResponse,
} from "./docker";

export type {
  EditableBookmarkGroup,
  EditableBookmarkItem,
  EditableConfig,
  EditableConfigWrite,
  EditableDatetimeInfo,
  EditableDiskEntry,
  EditableDiskField,
  EditableDockerEndpoint,
  EditableHttpProbe,
  EditableInfoWidget,
  EditableLayoutEntry,
  EditableMapping,
  EditableOpenMeteoInfo,
  EditableResourcesInfo,
  EditableServiceDocker,
  EditableServiceGroupView,
  EditableServiceGroupWrite,
  EditableServiceItemView,
  EditableServiceItemWrite,
  EditableServiceWidgetView,
  EditableServiceWidgetWrite,
  EditableSettings,
  LinkTarget,
  SecretFieldView,
  SecretFieldWrite,
} from "./editable";

export type {
  InfoWidgetType,
  OpenMeteoInfoResponse,
  ResourceAvailableItem,
  ResourceItem,
  ResourceUnavailableItem,
  ResourcesInfoResponse,
  WeatherDailyItem,
  WeatherHourlyItem,
} from "./info";

export type {
  HttpProbeResponse,
  HttpProbeState,
  HttpUnreachableReason,
} from "./probe";

export type {
  EmbySessionSummary,
  ServiceWidgetOkResponse,
  ServiceWidgetResult,
  ServiceWidgetType,
} from "./widget";

export {
  ApiRoutes,
  parseApiSuccess,
  parseErrorEnvelope,
  type ApiRouteKey,
  type ApiSuccessResponses,
  type ApiSuccessRoute,
  type AssetUploadSuccessResponse,
  type ConfigSuccessResponse,
  type ConfigWriteSuccessResponse,
  type DockerBatchSuccessResponse,
  type DockerContainersSuccessResponse,
  type DockerSuccessResponse,
  type EditableConfigSuccessResponse,
  type IconCandidate,
  type IconImportSuccessResponse,
  type IconResolveSuccessResponse,
  type InfoSuccessResponse,
  type ProbeSuccessResponse,
  type SiteIconTierContract,
  type VersionSuccessResponse,
  type WidgetSuccessResponse,
} from "./api";
