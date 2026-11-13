/** 通用契约：错误体、指标与状态码区间。仅 TS 类型，运行时校验在服务端。 */

/** 可安全外露的错误体，只含文案与配置定位 */
export type PublicError = {
  message: string;
  file?: string | undefined;
  path?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  code?: string | undefined;
};

/** HTTP 探测可接受的状态码闭区间 */
export type StatusRange = {
  min: number;
  max: number;
};

export type MetricStatus = "ok" | "warn" | "error" | "unavailable";

export type Metric = {
  id: string;
  label: string;
  value: string | number;
  unit?: string | undefined;
  status?: MetricStatus | undefined;
};

/** 失败响应信封，ok 恒为 false */
export type ErrorEnvelope = {
  ok: false;
  error: PublicError;
};
