/** 中国国标空气质量指数（HJ 633）六档。 */

export type ChinaAqiLevel =
  | "excellent"
  | "good"
  | "light"
  | "moderate"
  | "heavy"
  | "severe";

export type ChinaAqiInfo = {
  value: number;
  level: ChinaAqiLevel;
  /** 优 / 良 / 轻度 / 中度 / 重度 / 严重 */
  label: string;
};

const LEVELS: ReadonlyArray<{
  max: number;
  level: ChinaAqiLevel;
  label: string;
}> = [
  { max: 50, level: "excellent", label: "优" },
  { max: 100, level: "good", label: "良" },
  { max: 150, level: "light", label: "轻度" },
  { max: 200, level: "moderate", label: "中度" },
  { max: 300, level: "heavy", label: "重度" },
  { max: Number.POSITIVE_INFINITY, level: "severe", label: "严重" },
];

/** 非法或非有限数字返回 null。 */
export function chinaAqiInfo(value: number): ChinaAqiInfo | null {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  const rounded = Math.round(value);
  for (const row of LEVELS) {
    if (rounded <= row.max) {
      return { value: rounded, level: row.level, label: row.label };
    }
  }
  return {
    value: rounded,
    level: "severe",
    label: "严重",
  };
}

/** Tailwind 文本色（亮/暗适配）。 */
export function chinaAqiTextClass(level: ChinaAqiLevel): string {
  switch (level) {
    case "excellent":
      return "text-emerald-600 dark:text-emerald-400";
    case "good":
      return "text-lime-600 dark:text-lime-400";
    case "light":
      return "text-amber-600 dark:text-amber-400";
    case "moderate":
      return "text-orange-600 dark:text-orange-400";
    case "heavy":
      return "text-red-600 dark:text-red-400";
    case "severe":
      return "text-purple-700 dark:text-purple-400";
    default:
      return "text-muted-foreground";
  }
}
