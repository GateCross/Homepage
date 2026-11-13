/** 可编辑配置契约（GET /api/config/editable 与 PUT /api/config 的请求体）。 */

/** GET 可编辑配置中的密钥字段视图：仅状态，无明文 */
export type SecretFieldView = {
  status: "configured" | "unset";
};

/** PUT 写回时的密钥字段三态 */
export type SecretFieldWrite =
  | { mode: "keep" }
  | { mode: "set"; value: string }
  | { mode: "clear" };

export type LinkTarget = "_blank" | "_self" | "_parent" | "_top";

export type EditableLayoutEntry = {
  groupName: string;
  maxColumns: number;
};

export type EditableSettings = {
  title: string;
  background?: string | undefined;
  favicon?: string | undefined;
  useEqualHeights: boolean;
  layout: EditableLayoutEntry[];
};

export type EditableHttpProbe = {
  enabled: boolean;
  url?: string | undefined;
  expectedStatus?: string | undefined;
  timeoutSec?: number | undefined;
};

export type EditableMapping = {
  field?: string | undefined;
  label?: string | undefined;
  format?: string | undefined;
  path?: string | undefined;
  id?: string | undefined;
};

/** GET 侧服务组件（密钥为 View） */
export type EditableServiceWidgetView = {
  type: string;
  url?: string | undefined;
  username?: SecretFieldView | undefined;
  password?: SecretFieldView | undefined;
  key?: SecretFieldView | undefined;
  apiKey?: SecretFieldView | undefined;
  token?: SecretFieldView | undefined;
  method?: "GET" | undefined;
  headers?: { name: string; value: SecretFieldView }[] | undefined;
  mappings?: EditableMapping[] | undefined;
  /** Emby：媒体库数量块 */
  enableBlocks?: boolean | undefined;
  /** Emby：正在播放 */
  enableNowPlaying?: boolean | undefined;
  /** Emby：会话显示用户名 */
  enableUser?: boolean | undefined;
  /** Emby：会话显示季集号 */
  showEpisodeNumber?: boolean | undefined;
  /** Emby / Immich / Caddy：限制展示字段 */
  fields?: string[] | undefined;
  /** Immich API 版本：1（默认）或 2（≥ v1.118） */
  version?: 1 | 2 | undefined;
};

/** PUT 侧服务组件（密钥为 Write） */
export type EditableServiceWidgetWrite = {
  type: string;
  url?: string | undefined;
  username?: SecretFieldWrite | undefined;
  password?: SecretFieldWrite | undefined;
  key?: SecretFieldWrite | undefined;
  apiKey?: SecretFieldWrite | undefined;
  token?: SecretFieldWrite | undefined;
  method?: "GET" | undefined;
  headers?: { name: string; value: SecretFieldWrite }[] | undefined;
  mappings?: EditableMapping[] | undefined;
  enableBlocks?: boolean | undefined;
  enableNowPlaying?: boolean | undefined;
  enableUser?: boolean | undefined;
  showEpisodeNumber?: boolean | undefined;
  fields?: string[] | undefined;
  version?: 1 | 2 | undefined;
};

export type EditableServiceDocker = {
  server: string;
  container: string;
};

export type EditableServiceItemView = {
  name: string;
  href?: string | undefined;
  target?: LinkTarget | undefined;
  icon?: string | undefined;
  description?: string | undefined;
  /** 为 true 时不进入公开配置 / 首页 / 搜索；编辑器仍可见 */
  hidden?: boolean | undefined;
  httpProbe?: EditableHttpProbe | undefined;
  docker?: EditableServiceDocker | undefined;
  widget?: EditableServiceWidgetView | undefined;
};

export type EditableServiceItemWrite = {
  name: string;
  href?: string | undefined;
  target?: LinkTarget | undefined;
  icon?: string | undefined;
  description?: string | undefined;
  /** 为 true 时不进入公开配置 / 首页 / 搜索；编辑器仍可见 */
  hidden?: boolean | undefined;
  httpProbe?: EditableHttpProbe | undefined;
  docker?: EditableServiceDocker | undefined;
  widget?: EditableServiceWidgetWrite | undefined;
};

export type EditableServiceGroupView = {
  name: string;
  items: EditableServiceItemView[];
};

export type EditableServiceGroupWrite = {
  name: string;
  items: EditableServiceItemWrite[];
};

export type EditableBookmarkItem = {
  name: string;
  href: string;
  target?: LinkTarget | undefined;
  icon?: string | undefined;
  abbr?: string | undefined;
  description?: string | undefined;
};

export type EditableBookmarkGroup = {
  name: string;
  items: EditableBookmarkItem[];
};

export type EditableDatetimeInfo = {
  type: "datetime";
  timezone?: string | undefined;
  label?: string | undefined;
  format?: {
    timeStyle?: string | undefined;
    dateStyle?: string | undefined;
    hour12?: boolean | undefined;
  };
};

export type EditableOpenMeteoInfo = {
  type: "openmeteo";
  /** 中国天气网城市编码，如 101020100（上海） */
  cityId: string;
  /** 地点名称，用于前端展示 */
  location: string;
  label?: string | undefined;
};

/** 磁盘条目：路径 + 可选展示别名 */
export type EditableDiskEntry = {
  path: string;
  label?: string | undefined;
};

/**
 * disk 兼容形态：
 * - 字符串：单个路径，或多个「路径|别名」用逗号分隔
 * - 字符串数组：路径或「路径|别名」
 * - 对象数组：{ path, label? }
 */
export type EditableDiskField = string | (string | EditableDiskEntry)[];

export type EditableResourcesInfo = {
  type: "resources";
  cpu?: boolean | undefined;
  memory?: boolean | undefined;
  disk?: EditableDiskField | undefined;
  label?: string | undefined;
};

export type EditableInfoWidget =
  | EditableDatetimeInfo
  | EditableOpenMeteoInfo
  | EditableResourcesInfo;

export type EditableDockerEndpoint = {
  name: string;
  connection: string;
};

/** GET /api/config/editable 成功体 */
export type EditableConfig = {
  settings: EditableSettings;
  services: EditableServiceGroupView[];
  bookmarks: EditableBookmarkGroup[];
  infoWidgets: EditableInfoWidget[];
  dockerEndpoints: EditableDockerEndpoint[];
};

/**
 * PUT /api/config 请求体。
 * 与 EditableConfig 同形，但密钥字段为 Write 三态。
 * 旁路字段（allowList / secrets / resolved*）由服务端解析层显式剔除。
 */
export type EditableConfigWrite = {
  settings: EditableSettings;
  services: EditableServiceGroupWrite[];
  bookmarks: EditableBookmarkGroup[];
  infoWidgets: EditableInfoWidget[];
  dockerEndpoints: EditableDockerEndpoint[];
};

/** PUT /api/config 成功响应：不含敏感回显 */
export type ConfigWriteSuccessResponse = {
  ok: true;
};
