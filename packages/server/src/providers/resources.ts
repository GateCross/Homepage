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

export type ResourcesCollector = {
  collectCpuPercent: () => number | Promise<number>;
  collectMemoryPercent: () => number | Promise<number>;
  collectDiskPercent: (
    diskPath: string,
  ) => Promise<
    | { ok: true; percent: number }
    | { ok: false; message: string }
  >;
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

export function defaultCollectCpuPercent(): number {
  const cpus = os.cpus();
  const n = Math.max(1, cpus.length);
  const load = os.loadavg()[0] ?? 0;
  if (!Number.isFinite(load) || load < 0) {
    return clampPercent(0);
  }
  return clampPercent((load / n) * 100);
}

export function defaultCollectMemoryPercent(): number {
  const total = os.totalmem();
  if (!Number.isFinite(total) || total <= 0) {
    return clampPercent(0);
  }
  const free = os.freemem();
  const used = total - (Number.isFinite(free) ? free : 0);
  return clampPercent((used / total) * 100);
}

export async function defaultCollectDiskPercent(
  diskPath: string,
): Promise<
  { ok: true; percent: number } | { ok: false; message: string }
> {
  try {
    const stats = await statfs(diskPath);
    const blocks = Number(stats.blocks);
    const bavail = Number(stats.bavail);
    if (!Number.isFinite(blocks) || blocks <= 0) {
      return { ok: false, message: "无法读取磁盘容量信息" };
    }
    const available = Number.isFinite(bavail) ? Math.max(0, bavail) : 0;
    const usedRatio = 1 - available / blocks;
    return { ok: true, percent: clampPercent(usedRatio * 100) };
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

export function createDefaultResourcesCollector(): ResourcesCollector {
  return {
    collectCpuPercent: defaultCollectCpuPercent,
    collectMemoryPercent: defaultCollectMemoryPercent,
    collectDiskPercent: defaultCollectDiskPercent,
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
    const percent = clampPercent(await collector.collectMemoryPercent());
    items.push({
      id: "memory",
      label: "内存",
      percent,
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
    const result = await collector.collectDiskPercent(disk.path);
    if (result.ok) {
      items.push({
        id,
        label,
        percent: clampPercent(result.percent),
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
