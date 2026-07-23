import { z } from "zod";

/** Docker Healthcheck 结果（仅配置了 HEALTHCHECK 时有值） */
export const DockerHealthSchema = z.enum([
  "healthy",
  "unhealthy",
  "starting",
]);

export type DockerHealth = z.infer<typeof DockerHealthSchema>;

/** 运行中容器可选的资源占用（百分比 0–100） */
export const DockerResourceStatsSchema = z.object({
  cpuPercent: z.number().min(0).max(100).optional(),
  memoryPercent: z.number().min(0).max(100).optional(),
  /** 已用内存字节数；仅展示辅助，可缺省 */
  memoryUsageBytes: z.number().nonnegative().optional(),
  /** 内存上限字节数；可缺省 */
  memoryLimitBytes: z.number().positive().optional(),
});

export type DockerResourceStats = z.infer<typeof DockerResourceStatsSchema>;

/** 各状态可选的人类可读细节（如 Docker Status 原文片段） */
const DockerDetailFields = z.object({
  /** 健康检查状态；仅 running 常见 */
  health: DockerHealthSchema.optional(),
  /** 简短补充文案，如 "Up 3 hours" */
  detail: z.string().min(1).max(120).optional(),
});

export const DockerStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("loading"),
  }),
  z
    .object({
      status: z.literal("running"),
    })
    .merge(DockerResourceStatsSchema)
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("starting"),
    })
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("restarting"),
    })
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("paused"),
    })
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("stopped"),
    })
    .merge(DockerDetailFields),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string().min(1).optional(),
  }),
]);

export type DockerState = z.infer<typeof DockerStateSchema>;

export const DockerStatusResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("running"),
    })
    .merge(DockerResourceStatsSchema)
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("starting"),
    })
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("restarting"),
    })
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("paused"),
    })
    .merge(DockerDetailFields),
  z
    .object({
      status: z.literal("stopped"),
    })
    .merge(DockerDetailFields),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string().min(1).optional(),
  }),
]);

export type DockerStatusResponse = z.infer<typeof DockerStatusResponseSchema>;

/** 列表 API 返回的单容器摘要（无 Env/Labels/挂载等敏感字段） */
export const DockerContainerSummarySchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1).optional(),
  state: z.enum([
    "running",
    "starting",
    "restarting",
    "paused",
    "stopped",
    "other",
  ]),
  /** healthy / unhealthy / starting */
  health: DockerHealthSchema.optional(),
  statusText: z.string().min(1).optional(),
  ports: z.array(z.string().min(1)).optional(),
});

export type DockerContainerSummary = z.infer<
  typeof DockerContainerSummarySchema
>;

/** GET /api/docker/:server/containers 成功体 */
export const DockerContainersResponseSchema = z.object({
  ok: z.literal(true),
  server: z.string().min(1),
  containers: z.array(DockerContainerSummarySchema),
});

export type DockerContainersResponse = z.infer<
  typeof DockerContainersResponseSchema
>;

/** GET /api/docker/status 批量结果中的单条（已鉴权登记的容器） */
export const DockerBatchItemSchema = z.object({
  server: z.string().min(1),
  container: z.string().min(1),
  result: DockerStatusResponseSchema,
});

export type DockerBatchItem = z.infer<typeof DockerBatchItemSchema>;

/**
 * GET /api/docker/status 成功体：一次返回配置内全部已登记容器状态。
 * 默认含资源；`?stats=0` 时仅运行态/健康（running 可无 cpu/memory 字段）。
 */
export const DockerBatchStatusResponseSchema = z.object({
  ok: z.literal(true),
  results: z.array(DockerBatchItemSchema),
});

export type DockerBatchStatusResponse = z.infer<
  typeof DockerBatchStatusResponseSchema
>;
