/** 公开配置契约（GET /api/config 成功体）。安全视图不得包含密钥明文、插值后密钥、headers 或 secrets。 */

export type LayoutGroup = {
  maxColumns: number;
};

export type NormalizedSettings = {
  title: string;
  background?: string | undefined;
  favicon?: string | undefined;
  useEqualHeights: boolean;
  layout: Record<string, LayoutGroup>;
};

export type InfoWidgetConfig = {
  infoId: string;
  type: string;
  unsupported?: boolean | undefined;
  options?: Record<string, unknown> | undefined;
};

/** 配置解析失败的单条占位，与正常条目同列 */
export type ServiceItemError = {
  kind: "error";
  message: string;
};

export type ServiceHttpProbe = {
  enabled: true;
  probeId: string;
};

export type ServiceDockerRef = {
  server: string;
  container: string;
};

export type ServiceWidgetRef = {
  type: string;
  widgetId?: string | undefined;
  unsupported?: boolean | undefined;
  /** 组件级局部中文配置错误（如密钥环境变量缺失、customapi 非 GET）。有 error 时不登记 widgetId、不发网、不含密钥明文。 */
  error?: string | undefined;
};

export type NormalizedService = {
  id: string;
  name: string;
  href?: string | undefined;
  target: string;
  icon?: string | undefined;
  description?: string | undefined;
  weight?: number | undefined;
  httpProbe?: ServiceHttpProbe | undefined;
  docker?: ServiceDockerRef | undefined;
  widget?: ServiceWidgetRef | undefined;
  pingUnsupported?: boolean | undefined;
};

export type ServiceGroupItem = NormalizedService | ServiceItemError;

export type ServiceGroup = {
  name: string;
  items: ServiceGroupItem[];
};

export type BookmarkItemError = {
  kind: "error";
  message: string;
};

export type NormalizedBookmark = {
  id: string;
  name: string;
  href: string;
  target: string;
  icon?: string | undefined;
  abbr?: string | undefined;
  description?: string | undefined;
};

export type BookmarkGroupItem = NormalizedBookmark | BookmarkItemError;

export type BookmarkGroup = {
  name: string;
  items: BookmarkGroupItem[];
};

export type NormalizedConfig = {
  settings: NormalizedSettings;
  services: ServiceGroup[];
  bookmarks: BookmarkGroup[];
  infoWidgets: InfoWidgetConfig[];
};
