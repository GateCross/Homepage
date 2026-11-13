/**
 * Docker 两阶段合并的行为契约。
 * 这些断言锁定「轻量轮询不会闪掉指标、整批失败不会抹掉已有徽章」两条不变式。
 */
import { describe, expect, it } from "vitest";

import type { DockerStatusResponse } from "@/lib/contracts";

import {
  dockerTargetKey,
  GLOBAL_ERROR_KEY,
  mapFromBatch,
  mergeDockerMaps,
  type DockerStatusMap,
} from "./docker-merge";

type RunningState = Extract<DockerStatusResponse, { status: "running" }>;

const running = (extra: Partial<RunningState> = {}): DockerStatusResponse => ({
  status: "running",
  ...extra,
});

const stopped = (): DockerStatusResponse => ({ status: "stopped" });

function mapOf(
  server: string,
  container: string,
  data: DockerStatusResponse,
): DockerStatusMap {
  return new Map([
    [dockerTargetKey(server, container), { status: "success", data }],
  ]);
}

/** 取出某个键的状态结果，断言为成功并返回其数据 */
function successData(map: DockerStatusMap, key: string): DockerStatusResponse {
  const entry = map.get(key);
  if (entry?.status !== "success") {
    throw new Error(`期望 success，实得 ${entry?.status ?? "undefined"}`);
  }
  return entry.data;
}

/** 断言数据为 running 并收窄，便于访问资源字段 */
function asRunning(data: DockerStatusResponse): RunningState {
  if (data.status !== "running") {
    throw new Error(`期望 running，实得 ${data.status}`);
  }
  return data;
}

describe("mergeDockerMaps 基本覆盖", () => {
  it("新结果覆盖同键的旧状态", () => {
    const prev = mapOf("s", "c", stopped());
    const next = mergeDockerMaps(prev, mapOf("s", "c", running()), "full");
    expect(successData(next, dockerTargetKey("s", "c")).status).toBe("running");
  });

  it("不修改入参 map", () => {
    const prev = mapOf("s", "c", stopped());
    const incoming = mapOf("s", "d", running());
    mergeDockerMaps(prev, incoming, "lite");
    expect(prev.size).toBe(1);
    expect(incoming.size).toBe(1);
  });

  it("新增键被并入，已有键不丢失", () => {
    const prev = mapOf("s", "a", running());
    const next = mergeDockerMaps(prev, mapOf("s", "b", running()), "lite");
    expect(next.size).toBe(2);
  });
});

describe("mergeDockerMaps lite 覆盖 full 时保留指标", () => {
  const withMetrics = running({
    cpuPercent: 12.5,
    memoryPercent: 40,
    memoryUsageBytes: 1024,
    memoryLimitBytes: 2048,
  });
  const withoutMetrics = running();

  it("lite 结果缺少指标时沿用上一拍的指标", () => {
    const prev = mapOf("s", "c", withMetrics);
    const next = mergeDockerMaps(prev, mapOf("s", "c", withoutMetrics), "lite");
    const data = asRunning(successData(next, dockerTargetKey("s", "c")));
    expect(data.cpuPercent).toBe(12.5);
    expect(data.memoryPercent).toBe(40);
    expect(data.memoryUsageBytes).toBe(1024);
    expect(data.memoryLimitBytes).toBe(2048);
  });

  it("lite 结果自带指标时以新值为准", () => {
    const prev = mapOf("s", "c", withMetrics);
    const fresh = running({ cpuPercent: 99 });
    const next = mergeDockerMaps(prev, mapOf("s", "c", fresh), "lite");
    const data = asRunning(successData(next, dockerTargetKey("s", "c")));
    expect(data.cpuPercent).toBe(99);
  });

  it("full 模式不做保留，完整以新结果为准", () => {
    const prev = mapOf("s", "c", withMetrics);
    const next = mergeDockerMaps(prev, mapOf("s", "c", withoutMetrics), "full");
    const data = asRunning(successData(next, dockerTargetKey("s", "c")));
    expect(data.cpuPercent).toBeUndefined();
  });

  it("上一拍已停止时不保留指标", () => {
    const prev = mapOf("s", "c", stopped());
    const next = mergeDockerMaps(prev, mapOf("s", "c", withoutMetrics), "lite");
    const data = asRunning(successData(next, dockerTargetKey("s", "c")));
    expect(data.cpuPercent).toBeUndefined();
  });

  it("新状态已停止时不保留指标", () => {
    const prev = mapOf("s", "c", withMetrics);
    const next = mergeDockerMaps(prev, mapOf("s", "c", stopped()), "lite");
    const data = successData(next, dockerTargetKey("s", "c"));
    expect(data.status).toBe("stopped");
  });
});

describe("mergeDockerMaps 失败与全局错误", () => {
  it("入参里的失败条目按原样并入", () => {
    const prev: DockerStatusMap = new Map();
    const incoming: DockerStatusMap = new Map([
      [dockerTargetKey("s", "c"), { status: "error", message: "查询失败" }],
    ]);
    const next = mergeDockerMaps(prev, incoming, "full");
    expect(next.get(dockerTargetKey("s", "c"))?.status).toBe("error");
  });

  it("成功合并会清掉全局错误键", () => {
    const prev: DockerStatusMap = new Map([
      [GLOBAL_ERROR_KEY, { status: "error", message: "整批失败" }],
    ]);
    const next = mergeDockerMaps(prev, mapOf("s", "c", running()), "lite");
    expect(next.has(GLOBAL_ERROR_KEY)).toBe(false);
  });

  it("全局错误不阻止已知条目继续更新", () => {
    const prev: DockerStatusMap = new Map([
      [GLOBAL_ERROR_KEY, { status: "error", message: "整批失败" }],
    ]);
    const next = mergeDockerMaps(prev, mapOf("s", "c", stopped()), "lite");
    expect(next.size).toBe(1);
    expect(next.has(dockerTargetKey("s", "c"))).toBe(true);
  });
});

describe("mapFromBatch", () => {
  it("按 server 与 container 组合成键", () => {
    const map = mapFromBatch([
      { server: "a", container: "x", result: running() },
      { server: "b", container: "y", result: stopped() },
    ]);
    expect(map.size).toBe(2);
    expect(map.get(dockerTargetKey("a", "x"))?.status).toBe("success");
  });

  it("空结果得到空 map", () => {
    expect(mapFromBatch([]).size).toBe(0);
  });
});

describe("dockerTargetKey", () => {
  it("不同组合不会撞键", () => {
    expect(dockerTargetKey("a", "b")).not.toBe(dockerTargetKey("ab", ""));
    expect(dockerTargetKey("a", "b")).not.toBe(dockerTargetKey("a", "b "));
  });

  it("与全局错误键不冲突，空 server 与空 container 亦然", () => {
    expect(dockerTargetKey("", "")).not.toBe(GLOBAL_ERROR_KEY);
    expect(dockerTargetKey("", "x")).not.toBe(GLOBAL_ERROR_KEY);
  });
});
