/**
 * Docker 状态两阶段轮询的合并逻辑。
 * lite 只带运行态，full 含 CPU/内存；两段结果按规则合并成一个视图。
 */
import type { DockerStatusResponse } from "@/lib/contracts";

export type DockerEntryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: DockerStatusResponse };

export type DockerStatusMap = Map<string, DockerEntryState>;

/** 全局错误（整批失败）在 map 里的键；前缀保证与任何容器键都不相等 */
export const GLOBAL_ERROR_KEY = "\0global-error";

/**
 * 容器键：server 与 container 用 \0 拼接。
 * 加固定前缀，避免两者都为空串时退化成 GLOBAL_ERROR_KEY。
 */
export function dockerTargetKey(server: string, container: string): string {
  return `\0target\0${server}\0${container}`;
}

/** 该状态是否带资源指标；非 running 一律视为没有 */
function hasResourceMetrics(data: DockerStatusResponse): boolean {
  if (data.status !== "running") return false;
  return data.cpuPercent !== undefined || data.memoryPercent !== undefined;
}

/**
 * 合并 lite（状态）与 full（含 stats）：
 * - 新结果优先覆盖状态字段
 * - full 失败时不抹掉已有徽章
 * - lite 覆盖 full 时保留已有 metrics，避免轮询轻量阶段指标闪空
 */
export function mergeDockerMaps(
  prev: DockerStatusMap,
  incoming: DockerStatusMap,
  mode: "lite" | "full",
): DockerStatusMap {
  const next = new Map(prev);
  next.delete(GLOBAL_ERROR_KEY);

  for (const [key, entry] of incoming) {
    if (entry.status !== "success") {
      next.set(key, entry);
      continue;
    }

    const prevEntry = prev.get(key);
    if (
      mode === "lite" &&
      prevEntry?.status === "success" &&
      prevEntry.data.status === "running" &&
      entry.data.status === "running" &&
      hasResourceMetrics(prevEntry.data) &&
      !hasResourceMetrics(entry.data)
    ) {
      next.set(key, {
        status: "success",
        data: {
          ...entry.data,
          ...(prevEntry.data.cpuPercent !== undefined
            ? { cpuPercent: prevEntry.data.cpuPercent }
            : {}),
          ...(prevEntry.data.memoryPercent !== undefined
            ? { memoryPercent: prevEntry.data.memoryPercent }
            : {}),
          ...(prevEntry.data.memoryUsageBytes !== undefined
            ? { memoryUsageBytes: prevEntry.data.memoryUsageBytes }
            : {}),
          ...(prevEntry.data.memoryLimitBytes !== undefined
            ? { memoryLimitBytes: prevEntry.data.memoryLimitBytes }
            : {}),
        },
      });
      continue;
    }

    next.set(key, entry);
  }
  return next;
}

/** 把批量接口的结果转成状态表，全部按成功处理 */
export function mapFromBatch(
  results: ReadonlyArray<{
    server: string;
    container: string;
    result: DockerStatusResponse;
  }>,
): DockerStatusMap {
  const next: DockerStatusMap = new Map();
  for (const item of results) {
    next.set(dockerTargetKey(item.server, item.container), {
      status: "success",
      data: item.result,
    });
  }
  return next;
}
