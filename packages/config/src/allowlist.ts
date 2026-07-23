/** 当次请求 AllowList（仅服务端；由 loadConfig 每次重建）。 密钥与真实出站目标只保存在此结构中，不得进入 NormalizedConfig。 */
import type { StatusRange } from "@homepage/domain";

export type HttpProbeTarget = {
  url: string;
  expectedStatus?: StatusRange[];

  timeoutMs: number;
};

/** 已解析的服务组件密钥（仅服务端） */
export type ResolvedSecrets = Readonly<Record<string, string>>;

export type WidgetTarget = {
  type: string;
  url: string;
  secrets: ResolvedSecrets;
  options: unknown;
};

export type InfoTarget = {
  type: string;
  options: unknown;
};

export type DockerEndpoint =
  | { kind: "unix"; socketPath: string }
  | {
      kind: "tcp";
      host: string;
      port: number;
      /** true：HTTPS/TLS（如 https://host:2376）；false/缺省：plain TCP */
      tls?: boolean | undefined;
    };

/** 当次配置加载产生的允许列表。 使用 Map/Set，便于 O(1) 鉴权；不跨请求缓存为唯一真相。 */
export type AllowList = {
  httpProbeTargets: Map<string, HttpProbeTarget>;
  widgetTargets: Map<string, WidgetTarget>;
  infoTargets: Map<string, InfoTarget>;
  dockerEndpoints: Map<string, DockerEndpoint>;

  dockerContainers: Set<string>;
};

/** 创建空的当次 AllowList */
export function createEmptyAllowList(): AllowList {
  return {
    httpProbeTargets: new Map(),
    widgetTargets: new Map(),
    infoTargets: new Map(),
    dockerEndpoints: new Map(),
    dockerContainers: new Set(),
  };
}
