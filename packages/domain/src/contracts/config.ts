import { z } from "zod";

/** 安全视图不得包含密钥明文、插值后密钥、headers 或 secrets。 */
export const LayoutGroupSchema = z.object({
  maxColumns: z.number().int().positive(),
});

export type LayoutGroup = z.infer<typeof LayoutGroupSchema>;

export const NormalizedSettingsSchema = z.object({
  title: z.string().min(1),
  background: z.string().min(1).optional(),
  favicon: z.string().min(1).optional(),
  useEqualHeights: z.boolean(),
  layout: z.record(z.string(), LayoutGroupSchema),
});

export type NormalizedSettings = z.infer<typeof NormalizedSettingsSchema>;

export const InfoWidgetConfigSchema = z.object({
  infoId: z.string().min(1),

  type: z.string().min(1),
  unsupported: z.boolean().optional(),

  options: z.record(z.string(), z.unknown()).optional(),
});

export type InfoWidgetConfig = z.infer<typeof InfoWidgetConfigSchema>;

export const ServiceItemErrorSchema = z.object({
  kind: z.literal("error"),
  message: z.string().min(1),
});

export type ServiceItemError = z.infer<typeof ServiceItemErrorSchema>;

export const ServiceHttpProbeSchema = z.object({
  enabled: z.literal(true),
  probeId: z.string().min(1),
});

export type ServiceHttpProbe = z.infer<typeof ServiceHttpProbeSchema>;

export const ServiceDockerRefSchema = z.object({
  server: z.string().min(1),
  container: z.string().min(1),
});

export type ServiceDockerRef = z.infer<typeof ServiceDockerRefSchema>;

export const ServiceWidgetRefSchema = z.object({
  type: z.string().min(1),
  widgetId: z.string().min(1).optional(),
  unsupported: z.boolean().optional(),
  /** 组件级局部中文配置错误（如密钥环境变量缺失、customapi 非 GET）。 有 error 时不得登记 widgetId / 不得发网；不得含密钥明文。 */
  error: z.string().min(1).optional(),
});

export type ServiceWidgetRef = z.infer<typeof ServiceWidgetRefSchema>;

export const NormalizedServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  href: z.string().min(1).optional(),
  target: z.string().min(1),
  icon: z.string().min(1).optional(),
  description: z.string().optional(),
  weight: z.number().optional(),
  httpProbe: ServiceHttpProbeSchema.optional(),
  docker: ServiceDockerRefSchema.optional(),
  widget: ServiceWidgetRefSchema.optional(),
  pingUnsupported: z.boolean().optional(),
});

export type NormalizedService = z.infer<typeof NormalizedServiceSchema>;

export const ServiceGroupItemSchema = z.union([
  NormalizedServiceSchema,
  ServiceItemErrorSchema,
]);

export type ServiceGroupItem = z.infer<typeof ServiceGroupItemSchema>;

export const ServiceGroupSchema = z.object({
  name: z.string().min(1),
  items: z.array(ServiceGroupItemSchema),
});

export type ServiceGroup = z.infer<typeof ServiceGroupSchema>;

export const BookmarkItemErrorSchema = z.object({
  kind: z.literal("error"),
  message: z.string().min(1),
});

export type BookmarkItemError = z.infer<typeof BookmarkItemErrorSchema>;

export const NormalizedBookmarkSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  href: z.string().min(1),
  target: z.string().min(1),
  icon: z.string().min(1).optional(),
  abbr: z.string().min(1).optional(),
  description: z.string().optional(),
});

export type NormalizedBookmark = z.infer<typeof NormalizedBookmarkSchema>;

export const BookmarkGroupItemSchema = z.union([
  NormalizedBookmarkSchema,
  BookmarkItemErrorSchema,
]);

export type BookmarkGroupItem = z.infer<typeof BookmarkGroupItemSchema>;

export const BookmarkGroupSchema = z.object({
  name: z.string().min(1),
  items: z.array(BookmarkGroupItemSchema),
});

export type BookmarkGroup = z.infer<typeof BookmarkGroupSchema>;

export const NormalizedConfigSchema = z.object({
  settings: NormalizedSettingsSchema,
  services: z.array(ServiceGroupSchema),
  bookmarks: z.array(BookmarkGroupSchema),
  infoWidgets: z.array(InfoWidgetConfigSchema),
});

export type NormalizedConfig = z.infer<typeof NormalizedConfigSchema>;
