export function clampPercent(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}
