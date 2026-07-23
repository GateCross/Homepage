import { statfs } from "node:fs/promises";
import os from "node:os";

import {
  ResourcesInfoResponseSchema,
  clampPercent,
  type ResourceItem,
  type ResourcesInfoResponse,
} from "@homepage/domain";

export type ResourceDiskEntry = {
  path: string;
  label?: string | undefined;
};

export type ResourcesTargetOptions = {
  /** 兼容旧 options：仅路径列表 */
  diskPaths: readonly string[];
  /** 路径 + 可选展示别名 */
  disks?: readonly ResourceDiskEntry[] | undefined;
  cpu: boolean;
  memory: boolean;
};

export type MemorySample = {
  percent: number;
  usedBytes: number;
  totalBytes: number;
};

export type DiskSample =
  | {
      ok: true;
      percent: number;
      usedBytes: number;
      totalBytes: number;
    }
  | { ok: false; message: string };

export type ResourcesCollector = {
  collectCpuPercent: () => number | Promise<number>;
  collectMemory: () => MemorySample | Promise<MemorySample>;
  collectDisk: (diskPath: string) => Promise<DiskSample>;
};

function parseDiskEntry(value: unknown): ResourceDiskEntry | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    // path|alias
    const pipe = trimmed.indexOf("|");
    if (pipe > 0) {
      const path = trimmed.slice(0, pipe).trim();
      const label = trimmed.slice(pipe + 1).trim();
      if (path.length === 0) return null;
      return label.length > 0 ? { path, label } : { path };
    }
    const colon = trimmed.match(/^(.+?)[：:](.+)$/);
    if (colon) {
      const left = colon[1]!.trim();
      const right = colon[2]!.trim();
      if (!(left.length === 1 && /[A-Za-z]/.test(left))) {
        if (left.length === 0) return null;
        return right.length > 0 ? { path: left, label: right } : { path: left };
      }
    }
    return { path: trimmed };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const pathRaw =
      typeof obj["path"] === "string"
        ? obj["path"]
        : typeof obj["disk"] === "string"
          ? obj["disk"]
          : undefined;
    if (pathRaw === undefined || pathRaw.trim().length === 0) return null;
    const labelRaw =
      typeof obj["label"] === "string"
        ? obj["label"]
        : typeof obj["name"] === "string"
          ? obj["name"]
          : typeof obj["alias"] === "string"
            ? obj["alias"]
            : undefined;
    const label =
      labelRaw !== undefined && labelRaw.trim().length > 0
        ? labelRaw.trim()
        : undefined;
    return label !== undefined
      ? { path: pathRaw.trim(), label }
      : { path: pathRaw.trim() };
  }
  return null;
}

export function parseResourcesTargetOptions(
  options: unknown,
): ResourcesTargetOptions | null {
  if (options === null || options === undefined || typeof options !== "object") {
    return null;
  }
  const obj = options as Record<string, unknown>;
  const cpu = obj["cpu"] !== false;
  const memory = obj["memory"] !== false;

  const disks: ResourceDiskEntry[] = [];
  const seen = new Set<string>();

  const pushList = (raw: unknown): void => {
    if (raw === undefined || raw === null) return;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      const entry = parseDiskEntry(item);
      if (!entry || seen.has(entry.path)) continue;
      seen.add(entry.path);
      disks.push(entry);
    }
  };

  // 优先结构化 disks，再回退 diskPaths
  pushList(obj["disks"]);
  pushList(obj["diskPaths"]);

  return { diskPaths: disks.map((d) => d.path), disks, cpu, memory };
}

/** 进程内上一拍 CPU 时间片；差分得出真实使用率（非 loadavg 伪百分比） */
type CpuTimesSnapshot = {
  idle: number;
  total: number;
  at: number;
};

let previousCpuTimes: CpuTimesSnapshot | null = null;

function readCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** 冷启动两次采样间隔；用 setTimeout 让出事件循环，避免 busy-wait */
export const CPU_SEED_GAP_MS = 80;

/**
 * 基于两次 `os.cpus()` 时间片差分计算 CPU%。
 * 无上一拍时短间隔采第二拍（async），保证首包也有真实值。
 */
export async function defaultCollectCpuPercent(): Promise<number> {
  const sample = (): number => {
    const now = readCpuTimes();
    const prev = previousCpuTimes;
    previousCpuTimes = { ...now, at: Date.now() };
    if (prev === null) {
      return Number.NaN;
    }
    const idleDelta = now.idle - prev.idle;
    const totalDelta = now.total - prev.total;
    if (!Number.isFinite(totalDelta) || totalDelta <= 0) {
      return clampPercent(0);
    }
    const usedRatio = 1 - idleDelta / totalDelta;
    if (!Number.isFinite(usedRatio)) {
      return clampPercent(0);
    }
    return clampPercent(usedRatio * 100);
  };

  const first = sample();
  if (Number.isFinite(first)) {
    return first;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, CPU_SEED_GAP_MS);
  });
  const second = sample();
  return Number.isFinite(second) ? second : clampPercent(0);
}

export function defaultCollectMemory(): MemorySample {
  const total = os.totalmem();
  if (!Number.isFinite(total) || total <= 0) {
    return { percent: clampPercent(0), usedBytes: 0, totalBytes: 0 };
  }
  const free = os.freemem();
  const used = Math.max(0, total - (Number.isFinite(free) ? free : 0));
  return {
    percent: clampPercent((used / total) * 100),
    usedBytes: used,
    totalBytes: total,
  };
}

/** @deprecated 使用 defaultCollectMemory */
export function defaultCollectMemoryPercent(): number {
  return defaultCollectMemory().percent;
}

export async function defaultCollectDisk(diskPath: string): Promise<DiskSample> {
  try {
    const stats = await statfs(diskPath);
    const blocks = Number(stats.blocks);
    const bsize = Number(stats.bsize);
    const bavail = Number(stats.bavail);
    if (
      !Number.isFinite(blocks) ||
      blocks <= 0 ||
      !Number.isFinite(bsize) ||
      bsize <= 0
    ) {
      return { ok: false, message: "无法读取磁盘容量信息" };
    }
    const availableBlocks = Number.isFinite(bavail) ? Math.max(0, bavail) : 0;
    const totalBytes = blocks * bsize;
    const freeBytes = availableBlocks * bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedRatio = 1 - availableBlocks / blocks;
    return {
      ok: true,
      percent: clampPercent(usedRatio * 100),
      usedBytes,
      totalBytes,
    };
  } catch (err) {
    const code =
      err !== null &&
      err !== undefined &&
      typeof err === "object" &&
      "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return { ok: false, message: "磁盘路径不存在或不可访问" };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, message: "没有权限读取该磁盘路径" };
    }
    return { ok: false, message: "无法读取该磁盘使用率" };
  }
}

/** @deprecated 使用 defaultCollectDisk */
export async function defaultCollectDiskPercent(
  diskPath: string,
): Promise<
  { ok: true; percent: number } | { ok: false; message: string }
> {
  const result = await defaultCollectDisk(diskPath);
  if (!result.ok) return result;
  return { ok: true, percent: result.percent };
}

export function createDefaultResourcesCollector(): ResourcesCollector {
  return {
    collectCpuPercent: defaultCollectCpuPercent,
    collectMemory: defaultCollectMemory,
    collectDisk: defaultCollectDisk,
  };
}

export async function collectResourcesInfo(
  options: ResourcesTargetOptions,
  collector: ResourcesCollector = createDefaultResourcesCollector(),
): Promise<ResourcesInfoResponse> {
  const items: ResourceItem[] = [];

  if (options.cpu) {
    const percent = clampPercent(await collector.collectCpuPercent());
    items.push({
      id: "cpu",
      label: "CPU",
      percent,
    });
  }

  if (options.memory) {
    const sample = await collector.collectMemory();
    const hasBytes =
      Number.isFinite(sample.usedBytes) &&
      sample.usedBytes >= 0 &&
      Number.isFinite(sample.totalBytes) &&
      sample.totalBytes > 0;
    items.push({
      id: "memory",
      label: "内存",
      percent: clampPercent(sample.percent),
      ...(hasBytes
        ? { usedBytes: sample.usedBytes, totalBytes: sample.totalBytes }
        : {}),
    });
  }

  const disks: readonly ResourceDiskEntry[] =
    options.disks && options.disks.length > 0
      ? options.disks
      : options.diskPaths.map((path) => ({ path }));

  for (const disk of disks) {
    const id = `disk:${disk.path}`;
    // 有别名用别名；根路径默认「磁盘」；否则用路径（前端再做短展示）
    const label =
      disk.label && disk.label.trim().length > 0
        ? disk.label.trim()
        : disk.path === "/"
          ? "磁盘"
          : disk.path;
    const result = await collector.collectDisk(disk.path);
    if (result.ok) {
      const hasBytes =
        Number.isFinite(result.usedBytes) &&
        result.usedBytes >= 0 &&
        Number.isFinite(result.totalBytes) &&
        result.totalBytes > 0;
      items.push({
        id,
        label,
        percent: clampPercent(result.percent),
        ...(hasBytes
          ? { usedBytes: result.usedBytes, totalBytes: result.totalBytes }
          : {}),
      });
    } else {
      items.push({
        id,
        label,
        status: "unavailable",
        message: result.message,
      });
    }
  }

  return ResourcesInfoResponseSchema.parse({ items });
}
