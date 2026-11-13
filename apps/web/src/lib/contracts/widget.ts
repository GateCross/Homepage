/** 服务组件契约（GET /api/widgets/{widgetId}）。 */
import type { Metric } from "./common";

export type ServiceWidgetType =
  | "qbittorrent"
  | "transmission"
  | "emby"
  | "customapi"
  | "immich"
  | "caddy";

export type EmbySessionSummary = {
  id: string;
  title: string;
  user?: string | undefined;
  episode?: string | undefined;
  /** 播放进度 0–100 */
  progress?: number | undefined;
};

export type ServiceWidgetOkResponse = {
  metrics: Metric[];
  sessions?: EmbySessionSummary[] | undefined;
};

/** 服务组件结果。失败时 `error` 为中文说明，不得含密钥。 */
export type ServiceWidgetResult =
  | ({ ok: true } & ServiceWidgetOkResponse)
  | { ok: false; error: string };
