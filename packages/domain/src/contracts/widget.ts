import { z } from "zod";
import { MetricSchema } from "./common.js";

export const ServiceWidgetTypeSchema = z.enum([
  "qbittorrent",
  "transmission",
  "emby",
  "customapi",
]);

export type ServiceWidgetType = z.infer<typeof ServiceWidgetTypeSchema>;

export const EmbySessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  user: z.string().min(1).optional(),
  episode: z.string().min(1).optional(),
  /** 播放进度 0–100 */
  progress: z.number().min(0).max(100).optional(),
});

export type EmbySessionSummary = z.infer<typeof EmbySessionSummarySchema>;

export const ServiceWidgetOkResponseSchema = z.object({
  metrics: z.array(MetricSchema),
  sessions: z.array(EmbySessionSummarySchema).max(5).optional(),
});

export type ServiceWidgetOkResponse = z.infer<
  typeof ServiceWidgetOkResponseSchema
>;

/** 服务组件适配器 / `GET /api/widgets/:widgetId` 结果。 失败时 `error` 为中文说明，不得含密钥。 */
export const ServiceWidgetResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    metrics: z.array(MetricSchema),
    sessions: z.array(EmbySessionSummarySchema).max(5).optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
  }),
]);

export type ServiceWidgetResult = z.infer<typeof ServiceWidgetResultSchema>;
