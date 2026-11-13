/** Docker 状态契约（批量状态、单容器、容器列表）。 */

/** Docker Healthcheck 结果（仅配置了 HEALTHCHECK 时有值） */
export type DockerHealth = "healthy" | "unhealthy" | "starting";

/** 运行中容器可选的资源占用（百分比 0–100） */
export type DockerResourceStats = {
  cpuPercent?: number | undefined;
  memoryPercent?: number | undefined;
  /** 已用内存字节数；仅展示辅助，可缺省 */
  memoryUsageBytes?: number | undefined;
  /** 内存上限字节数；可缺省 */
  memoryLimitBytes?: number | undefined;
};

/** 各状态可选的人类可读细节 */
type DockerDetailFields = {
  /** 健康检查状态；仅 running 常见 */
  health?: DockerHealth | undefined;
  /** 简短补充文案，如 "Up 3 hours" */
  detail?: string | undefined;
};

/**
 * 单容器状态判别联合。
 * loading 仅用于前端本地占位，服务端不会下发。
 */
export type DockerState =
  | { status: "loading" }
  | ({ status: "running" } & DockerResourceStats & DockerDetailFields)
  | ({ status: "starting" } & DockerDetailFields)
  | ({ status: "restarting" } & DockerDetailFields)
  | ({ status: "paused" } & DockerDetailFields)
  | ({ status: "stopped" } & DockerDetailFields)
  | { status: "unavailable"; reason?: string | undefined };

/** 服务端下发的单容器状态（不含 loading） */
export type DockerStatusResponse = Exclude<DockerState, { status: "loading" }>;

/** 列表 API 返回的单容器摘要（无 Env/Labels/挂载等敏感字段） */
export type DockerContainerSummary = {
  name: string;
  image?: string | undefined;
  state:
    | "running"
    | "starting"
    | "restarting"
    | "paused"
    | "stopped"
    | "other";
  health?: DockerHealth | undefined;
  statusText?: string | undefined;
  ports?: string[] | undefined;
};

/** GET /api/docker/:server/containers 成功体 */
export type DockerContainersResponse = {
  ok: true;
  server: string;
  containers: DockerContainerSummary[];
};

/** GET /api/docker/status 批量结果中的单条（已鉴权登记的容器） */
export type DockerBatchItem = {
  server: string;
  container: string;
  result: DockerStatusResponse;
};

/**
 * GET /api/docker/status 成功体：一次返回配置内全部已登记容器状态。
 * 默认含资源；`?stats=0` 时仅运行态/健康（running 可无 cpu/memory 字段）。
 */
export type DockerBatchStatusResponse = {
  ok: true;
  results: DockerBatchItem[];
};
