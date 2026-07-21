import {
  buildInfoCanonical,
  buildProbeCanonical,
  buildServiceCanonical,
  buildWidgetCanonical,
  type InfoCanonicalInput,
  type ProbeCanonicalInput,
  type ServiceCanonicalInput,
  type WidgetCanonicalInput,
} from "./canonical.js";
import { buildStableId } from "./hash.js";

export type BuildServiceIdInput = ServiceCanonicalInput;
export type BuildProbeIdInput = ProbeCanonicalInput;
export type BuildWidgetIdInput = WidgetCanonicalInput;
export type BuildInfoIdInput = InfoCanonicalInput;

/** 生成稳定 `serviceId`。 身份：services + 分组索引 + 服务索引 + 规范化有效 href。 名称、描述、图标、weight、target 等展示字段不参与。 */
export function buildServiceId(input: BuildServiceIdInput): string {
  return buildStableId("service", buildServiceCanonical(input));
}

/** 生成稳定 `probeId`。 身份：服务位置 + 规范化探测 URL。 expectedStatus、超时与展示字段不参与。 */
export function buildProbeId(input: BuildProbeIdInput): string {
  return buildStableId("probe", buildProbeCanonical(input));
}

/** 生成稳定 `widgetId`。 身份：服务位置 + 有效组件列表索引 + 规范化类型 + 规范化目标 URL。 mappings、headers、账号密码 token 等均不参与。 */
export function buildWidgetId(input: BuildWidgetIdInput): string {
  return buildStableId("widget", buildWidgetCanonical(input));
}

export function buildInfoId(input: BuildInfoIdInput): string {
  return buildStableId("info", buildInfoCanonical(input));
}
