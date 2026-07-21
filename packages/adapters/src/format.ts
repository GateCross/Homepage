import { clampPercent } from "@homepage/domain";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s", "PB/s"] as const;

export function roundTo(value: number, digits = 2): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type ScaledUnitValue = {
  value: number;
  unit: string;
};

export function scaleBytes(bytes: number): ScaledUnitValue {
  let n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) {
    n = 0;
  }
  let unitIndex = 0;
  while (n >= 1000 && unitIndex < BYTE_UNITS.length - 1) {
    n /= 1000;
    unitIndex += 1;
  }
  return {
    value: roundTo(n, 2),
    unit: BYTE_UNITS[unitIndex]!,
  };
}

export function scaleByteRate(bytesPerSecond: number): ScaledUnitValue {
  let n = Number(bytesPerSecond);
  if (!Number.isFinite(n) || n < 0) {
    n = 0;
  }
  let unitIndex = 0;
  while (n >= 1000 && unitIndex < RATE_UNITS.length - 1) {
    n /= 1000;
    unitIndex += 1;
  }
  return {
    value: roundTo(n, 2),
    unit: RATE_UNITS[unitIndex]!,
  };
}

export function formatDurationSeconds(seconds: number): string {
  let s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) {
    s = 0;
  }
  s = Math.floor(s);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hours > 0) {
    return `${hours}小时${minutes}分${secs}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分${secs}秒`;
  }
  return `${secs}秒`;
}

export function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

export function formatPercentValue(value: unknown): number | null {
  const n = coerceFiniteNumber(value);
  if (n === null) {
    return null;
  }
  return clampPercent(n);
}
