import { z } from "zod";

/** GET 可编辑配置中的密钥字段视图：仅状态，无明文 */
export const SecretFieldViewSchema = z.object({
  status: z.enum(["configured", "unset"]),
});

export type SecretFieldView = z.infer<typeof SecretFieldViewSchema>;

/** PUT 写回时的密钥字段三态 */
export const SecretFieldWriteSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keep") }),
  z.object({
    mode: z.literal("set"),
    value: z.string(),
  }),
  z.object({ mode: z.literal("clear") }),
]);

export type SecretFieldWrite = z.infer<typeof SecretFieldWriteSchema>;

const LinkTargetSchema = z.enum(["_blank", "_self", "_parent", "_top"]);

export const EditableLayoutEntrySchema = z.object({
  groupName: z.string(),
  maxColumns: z.number().int().positive(),
});

export type EditableLayoutEntry = z.infer<typeof EditableLayoutEntrySchema>;

export const EditableSettingsSchema = z.object({
  title: z.string(),
  background: z.string().optional(),
  favicon: z.string().optional(),
  useEqualHeights: z.boolean(),
  layout: z.array(EditableLayoutEntrySchema),
});

export type EditableSettings = z.infer<typeof EditableSettingsSchema>;

export const EditableHttpProbeSchema = z.object({
  enabled: z.boolean(),
  url: z.string().optional(),
  expectedStatus: z.string().optional(),
  timeoutSec: z.number().int().min(1).max(60).optional(),
});

export type EditableHttpProbe = z.infer<typeof EditableHttpProbeSchema>;

const EditableMappingSchema = z.object({
  field: z.string().optional(),
  label: z.string().optional(),
  format: z.string().optional(),
  path: z.string().optional(),
  id: z.string().optional(),
});

/** GET 侧服务组件（密钥为 View） */
export const EditableServiceWidgetViewSchema = z.object({
  type: z.string().min(1),
  url: z.string().optional(),
  username: SecretFieldViewSchema.optional(),
  password: SecretFieldViewSchema.optional(),
  key: SecretFieldViewSchema.optional(),
  apiKey: SecretFieldViewSchema.optional(),
  token: SecretFieldViewSchema.optional(),
  method: z.literal("GET").optional(),
  headers: z
    .array(
      z.object({
        name: z.string().min(1),
        value: SecretFieldViewSchema,
      }),
    )
    .optional(),
  mappings: z.array(EditableMappingSchema).optional(),
  /** Emby：媒体库数量块 */
  enableBlocks: z.boolean().optional(),
  /** Emby：正在播放 */
  enableNowPlaying: z.boolean().optional(),
  /** Emby：会话显示用户名 */
  enableUser: z.boolean().optional(),
  /** Emby：会话显示季集号 */
  showEpisodeNumber: z.boolean().optional(),
  /** Emby：限制媒体数量字段（movies/series/episodes/songs） */
  fields: z.array(z.string()).optional(),
});

export type EditableServiceWidgetView = z.infer<
  typeof EditableServiceWidgetViewSchema
>;

/** PUT 侧服务组件（密钥为 Write） */
export const EditableServiceWidgetWriteSchema = z.object({
  type: z.string().min(1),
  url: z.string().optional(),
  username: SecretFieldWriteSchema.optional(),
  password: SecretFieldWriteSchema.optional(),
  key: SecretFieldWriteSchema.optional(),
  apiKey: SecretFieldWriteSchema.optional(),
  token: SecretFieldWriteSchema.optional(),
  method: z.literal("GET").optional(),
  headers: z
    .array(
      z.object({
        name: z.string().min(1),
        value: SecretFieldWriteSchema,
      }),
    )
    .optional(),
  mappings: z.array(EditableMappingSchema).optional(),
  enableBlocks: z.boolean().optional(),
  enableNowPlaying: z.boolean().optional(),
  enableUser: z.boolean().optional(),
  showEpisodeNumber: z.boolean().optional(),
  fields: z.array(z.string()).optional(),
});

export type EditableServiceWidgetWrite = z.infer<
  typeof EditableServiceWidgetWriteSchema
>;

export const EditableServiceDockerSchema = z.object({
  server: z.string().min(1),
  container: z.string().min(1),
});

export type EditableServiceDocker = z.infer<typeof EditableServiceDockerSchema>;

export const EditableServiceItemViewSchema = z.object({
  name: z.string(),
  href: z.string().optional(),
  target: LinkTargetSchema.optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  /** 为 true 时不进入公开配置 / 首页 / 搜索；编辑器仍可见 */
  hidden: z.boolean().optional(),
  httpProbe: EditableHttpProbeSchema.optional(),
  docker: EditableServiceDockerSchema.optional(),
  widget: EditableServiceWidgetViewSchema.optional(),
});

export type EditableServiceItemView = z.infer<
  typeof EditableServiceItemViewSchema
>;

export const EditableServiceItemWriteSchema = z.object({
  name: z.string(),
  href: z.string().optional(),
  target: LinkTargetSchema.optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  /** 为 true 时不进入公开配置 / 首页 / 搜索；编辑器仍可见 */
  hidden: z.boolean().optional(),
  httpProbe: EditableHttpProbeSchema.optional(),
  docker: EditableServiceDockerSchema.optional(),
  widget: EditableServiceWidgetWriteSchema.optional(),
});

export type EditableServiceItemWrite = z.infer<
  typeof EditableServiceItemWriteSchema
>;

export const EditableServiceGroupViewSchema = z.object({
  name: z.string(),
  items: z.array(EditableServiceItemViewSchema),
});

export type EditableServiceGroupView = z.infer<
  typeof EditableServiceGroupViewSchema
>;

export const EditableServiceGroupWriteSchema = z.object({
  name: z.string(),
  items: z.array(EditableServiceItemWriteSchema),
});

export type EditableServiceGroupWrite = z.infer<
  typeof EditableServiceGroupWriteSchema
>;

export const EditableBookmarkItemSchema = z.object({
  name: z.string(),
  href: z.string(),
  target: LinkTargetSchema.optional(),
  icon: z.string().optional(),
  abbr: z.string().optional(),
  description: z.string().optional(),
});

export type EditableBookmarkItem = z.infer<typeof EditableBookmarkItemSchema>;

export const EditableBookmarkGroupSchema = z.object({
  name: z.string(),
  items: z.array(EditableBookmarkItemSchema),
});

export type EditableBookmarkGroup = z.infer<typeof EditableBookmarkGroupSchema>;

export const EditableDatetimeInfoSchema = z.object({
  type: z.literal("datetime"),
  timezone: z.string().optional(),
  label: z.string().optional(),
  format: z
    .object({
      timeStyle: z.string().optional(),
      dateStyle: z.string().optional(),
      hour12: z.boolean().optional(),
    })
    .optional(),
});

export const EditableOpenMeteoInfoSchema = z.object({
  type: z.literal("openmeteo"),
  /** 中国天气网城市编码，如 101020100（上海） */
  cityId: z.string().min(1),
  /** 地点名称，用于前端展示 */
  location: z.string().min(1),
  label: z.string().optional(),
});

/** 磁盘条目：路径 + 可选展示别名 */
export const EditableDiskEntrySchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1).optional(),
});

export type EditableDiskEntry = z.infer<typeof EditableDiskEntrySchema>;

/**
 * disk 兼容形态：
 * - 字符串：单个路径，或多个「路径|别名」用逗号分隔
 * - 字符串数组：路径或「路径|别名」
 * - 对象数组：{ path, label? }
 */
export const EditableDiskFieldSchema = z.union([
  z.string(),
  z.array(z.union([z.string(), EditableDiskEntrySchema])),
]);

export type EditableDiskField = z.infer<typeof EditableDiskFieldSchema>;

export const EditableResourcesInfoSchema = z.object({
  type: z.literal("resources"),
  cpu: z.boolean().optional(),
  memory: z.boolean().optional(),
  disk: EditableDiskFieldSchema.optional(),
  label: z.string().optional(),
});

export const EditableInfoWidgetSchema = z.discriminatedUnion("type", [
  EditableDatetimeInfoSchema,
  EditableOpenMeteoInfoSchema,
  EditableResourcesInfoSchema,
]);

export type EditableInfoWidget = z.infer<typeof EditableInfoWidgetSchema>;

export const EditableDockerEndpointSchema = z.object({
  name: z.string().min(1),
  connection: z.string(),
});

export type EditableDockerEndpoint = z.infer<
  typeof EditableDockerEndpointSchema
>;

/** GET /api/config/editable 成功体 */
export const EditableConfigSchema = z.object({
  settings: EditableSettingsSchema,
  services: z.array(EditableServiceGroupViewSchema),
  bookmarks: z.array(EditableBookmarkGroupSchema),
  infoWidgets: z.array(EditableInfoWidgetSchema),
  dockerEndpoints: z.array(EditableDockerEndpointSchema),
});

export type EditableConfig = z.infer<typeof EditableConfigSchema>;

/**
 * PUT /api/config 请求体。
 * 与 EditableConfig 同形，但密钥字段为 Write 三态。
 * 旁路字段（allowList / secrets / resolved*）由解析层显式剔除，不进入 schema。
 */
export const EditableConfigWriteSchema = z.object({
  settings: EditableSettingsSchema,
  services: z.array(EditableServiceGroupWriteSchema),
  bookmarks: z.array(EditableBookmarkGroupSchema),
  infoWidgets: z.array(EditableInfoWidgetSchema),
  dockerEndpoints: z.array(EditableDockerEndpointSchema),
});

export type EditableConfigWrite = z.infer<typeof EditableConfigWriteSchema>;

/** PUT /api/config 成功响应：不含敏感回显 */
export const ConfigWriteSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export type ConfigWriteSuccessResponse = z.infer<
  typeof ConfigWriteSuccessResponseSchema
>;
