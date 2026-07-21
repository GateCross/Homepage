/** 风向角度 → 中文方位（8 方位）。 */

const DIRS = [
  "北",
  "东北",
  "东",
  "东南",
  "南",
  "西南",
  "西",
  "西北",
] as const;

export function windDirectionText(deg: number): string | null {
  if (!Number.isFinite(deg)) {
    return null;
  }
  const normalized = ((deg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return DIRS[index] ?? null;
}

export function formatWindLabel(
  speedKmh: number | undefined,
  directionDeg: number | undefined,
): string | null {
  if (speedKmh === undefined || !Number.isFinite(speedKmh) || speedKmh < 0) {
    return null;
  }
  const speed =
    Math.abs(speedKmh % 1) < 1e-9
      ? String(Math.trunc(speedKmh))
      : (Math.round(speedKmh * 10) / 10).toFixed(1);
  const dir =
    directionDeg !== undefined ? windDirectionText(directionDeg) : null;
  if (dir !== null) {
    return `${dir}风 ${speed} km/h`;
  }
  return `${speed} km/h`;
}
