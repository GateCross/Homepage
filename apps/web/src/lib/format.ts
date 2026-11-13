/**
 * 组件展示用的数值格式化。
 * 资源占用与 Docker 指标共用同一套：「—」表示无法展示，百分比按需要保留一位小数。
 */

/** 百分比；非有限数按「—」。整数不显示小数点，其余保留一位。 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded) || Math.abs(rounded % 1) < 1e-9) {
    return `${Math.trunc(rounded)}%`;
  }
  return `${rounded.toFixed(1)}%`;
}

/** 字节数转带单位的可读值；负数与非有限数按「—」。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/**
 * 占用类数值的告警色：80 以上用危险色，60 以上用警告色。
 * 阈值与配色统一到这里，避免同一含义在不同卡片上出现两种颜色。
 */
export function usageToneClass(percent: number): string {
  if (percent >= 90) return "text-status-danger";
  if (percent >= 75) return "text-status-warning";
  return "text-foreground/85";
}

/** 占用条填充色，与 usageToneClass 同一套阈值。 */
export function usageBarClass(percent: number): string {
  if (percent >= 90) return "bg-status-danger";
  if (percent >= 75) return "bg-status-warning";
  return "bg-status-online";
}
