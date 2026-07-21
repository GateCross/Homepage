import type {
  ServiceWidgetResult,
  ServiceWidgetType,
} from "@homepage/domain";

/** 已解析的服务端密钥（不得进入浏览器响应） */
export type AdapterSecrets = Readonly<Record<string, string>>;

/** 单次适配器调用输入。 由服务端从当次 AllowList.widgetTargets 映射而来。 */
export type AdapterRunInput = {

  url: string;
  /** 仅服务端持有的密钥 */
  secrets: AdapterSecrets;

  options: unknown;
};

export interface ServiceWidgetAdapter {

  readonly type: ServiceWidgetType;
  /** 拉取并转换指标。 实现不得将密钥写入返回值或抛出含密钥的错误信息。 */
  run(input: AdapterRunInput): Promise<ServiceWidgetResult>;
}

export type RunServiceWidgetInput = AdapterRunInput & {
  type: string;
};
