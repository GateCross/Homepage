import type { ServiceWidgetResult, ServiceWidgetType } from "@homepage/domain";

import { customApiAdapter } from "./customapi.js";
import { embyAdapter } from "./emby.js";
import { qbittorrentAdapter } from "./qbittorrent.js";
import { transmissionAdapter } from "./transmission.js";
import type {
  AdapterRunInput,
  RunServiceWidgetInput,
  ServiceWidgetAdapter,
} from "./types.js";
import {
  parseServiceWidgetResult,
  unsupportedWidgetResult,
  UNSUPPORTED_WIDGET_ERROR,
} from "./validate.js";

const serviceAdapters = new Map<string, ServiceWidgetAdapter>([
  [qbittorrentAdapter.type, qbittorrentAdapter],
  [transmissionAdapter.type, transmissionAdapter],
  [embyAdapter.type, embyAdapter],
  [customApiAdapter.type, customApiAdapter],
]);

export function registerServiceWidgetAdapter(
  adapter: ServiceWidgetAdapter,
): void {
  serviceAdapters.set(adapter.type, adapter);
}

export function getServiceWidgetAdapter(
  type: string,
): ServiceWidgetAdapter | undefined {
  return serviceAdapters.get(type);
}

export function listRegisteredServiceWidgetTypes(): ServiceWidgetType[] {
  return [
    qbittorrentAdapter.type,
    transmissionAdapter.type,
    embyAdapter.type,
    customApiAdapter.type,
  ].filter((type) => serviceAdapters.has(type));
}

/** 是否已注册该类型（未知类型不得发网）。 */
export function isRegisteredServiceWidgetType(type: string): boolean {
  return serviceAdapters.has(type);
}

export async function runServiceWidget(
  input: RunServiceWidgetInput,
): Promise<ServiceWidgetResult> {
  const adapter = getServiceWidgetAdapter(input.type);
  if (!adapter) {
    return unsupportedWidgetResult(UNSUPPORTED_WIDGET_ERROR);
  }

  const runInput: AdapterRunInput = {
    url: input.url,
    secrets: input.secrets,
    options: input.options,
  };

  let raw: unknown;
  try {
    raw = await adapter.run(runInput);
  } catch {
    // 适配器不得把密钥抛到上层；统一为中文局部错误
    return parseServiceWidgetResult({
      ok: false,
      error: "服务组件请求失败",
    });
  }

  return parseServiceWidgetResult(raw);
}
