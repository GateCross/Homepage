import {
  ServiceWidgetResultSchema,
  type Metric,
  type ServiceWidgetResult,
} from "@homepage/domain";

export const UNSUPPORTED_WIDGET_ERROR = "暂不支持该服务组件类型" as const;

export const INVALID_WIDGET_RESULT_ERROR =
  "服务组件返回结果无效" as const;

export function isMetricWellFormed(
  metric: Metric,
  seenIds: ReadonlySet<string>,
): boolean {
  if (typeof metric.id !== "string" || metric.id.length === 0) {
    return false;
  }
  if (seenIds.has(metric.id)) {
    return false;
  }
  if (typeof metric.label !== "string" || metric.label.length === 0) {
    return false;
  }
  // 中文标签：至少包含一个 CJK 统一表意文字（含扩展 A）
  if (!/[\u3400-\u9FFF]/.test(metric.label)) {
    return false;
  }
  if (metric.value === undefined || metric.value === null) {
    return false;
  }
  const valueType = typeof metric.value;
  if (valueType !== "string" && valueType !== "number") {
    return false;
  }
  if (valueType === "number" && !Number.isFinite(metric.value as number)) {
    return false;
  }
  return true;
}

export function validateSuccessMetrics(metrics: readonly Metric[]): boolean {
  const seen = new Set<string>();
  for (const metric of metrics) {
    if (!isMetricWellFormed(metric, seen)) {
      return false;
    }
    seen.add(metric.id);
  }
  return true;
}

export function parseServiceWidgetResult(value: unknown): ServiceWidgetResult {
  const parsed = ServiceWidgetResultSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: INVALID_WIDGET_RESULT_ERROR };
  }

  const result = parsed.data;
  if (result.ok && !validateSuccessMetrics(result.metrics)) {
    return { ok: false, error: INVALID_WIDGET_RESULT_ERROR };
  }

  return result;
}

export function unsupportedWidgetResult(
  message: string = UNSUPPORTED_WIDGET_ERROR,
): ServiceWidgetResult {
  return parseServiceWidgetResult({ ok: false, error: message });
}
