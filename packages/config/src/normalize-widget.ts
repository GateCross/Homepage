/**
 * 服务组件规范化。
 * - 不支持类型时卡片组件区标记暂不支持
 * - 密钥整值 `${ENV_VAR}` 插值；缺失或空 → 组件级中文配置错误且不登记
 * - 目标 URL / secrets / options 仅进入 AllowList
 */
import {
  buildWidgetId,
  interpolateEnvWholeValue,
  normalizeAbsoluteHttpUrl,
  normalizeTypeToken,
  type ServiceWidgetRef,
  type ServiceWidgetType,
} from "@homepage/domain";

import type { AllowList, ResolvedSecrets, WidgetTarget } from "./allowlist.js";

export const SUPPORTED_SERVICE_WIDGET_TYPES = [
  "qbittorrent",
  "transmission",
  "emby",
  "customapi",
] as const satisfies readonly ServiceWidgetType[];

const SUPPORTED_SET = new Set<string>(SUPPORTED_SERVICE_WIDGET_TYPES);

/** 视为密钥、仅服务端持有的字段名 */
const SECRET_FIELD_NAMES = [
  "password",
  "key",
  "apiKey",
  "token",
  "username",
] as const;

export type NormalizeWidgetEnv = Readonly<Record<string, string | undefined>>;

export type NormalizeWidgetContext = {
  groupIndex: number;
  serviceIndex: number;
  allowList?: AllowList;
  env: NormalizeWidgetEnv;
};

export function pickEffectiveWidgetDeclarations(
  source: Record<string, unknown>,
): unknown[] {
  if (Array.isArray(source["widgets"])) {
    return source["widgets"];
  }
  if (
    source["widget"] !== undefined &&
    source["widget"] !== null &&
    typeof source["widget"] === "object" &&
    !Array.isArray(source["widget"])
  ) {
    return [source["widget"]];
  }
  return [];
}

export function findFirstSupportedWidget(list: unknown[]): {
  widgetIndex: number;
  raw: Record<string, unknown>;
  type: ServiceWidgetType;
} | null {
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (
      entry === null ||
      entry === undefined ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const typeRaw = raw["type"];
    if (typeof typeRaw !== "string") {
      continue;
    }
    const type = normalizeTypeToken(typeRaw);
    if (SUPPORTED_SET.has(type)) {
      return { widgetIndex: i, raw, type: type as ServiceWidgetType };
    }
  }
  return null;
}

function findFirstTypedWidget(
  list: unknown[],
): { type: string } | null {
  for (const entry of list) {
    if (
      entry === null ||
      entry === undefined ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const typeRaw = (entry as Record<string, unknown>)["type"];
    if (typeof typeRaw === "string" && typeRaw.trim().length > 0) {
      return { type: normalizeTypeToken(typeRaw) };
    }
  }
  return null;
}

const SECRET_FIELD_LABELS: Readonly<Record<string, string>> = {
  password: "密码",
  key: "密钥",
  apiKey: "API 密钥",
  token: "令牌",
  username: "用户名",
};

function secretFieldLabel(fieldName: string): string {
  return SECRET_FIELD_LABELS[fieldName] ?? "凭证字段";
}

export function resolveSecretString(
  raw: unknown,
  env: NormalizeWidgetEnv,
  fieldLabel: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") {
    return {
      ok: false,
      message: `${fieldLabel}必须为字符串`,
    };
  }

  const result = interpolateEnvWholeValue(raw, env);
  switch (result.kind) {
    case "unchanged":
      return { ok: true, value: result.value };
    case "resolved":
      return { ok: true, value: result.value };
    case "missing":
      return {
        ok: false,
        message: `环境变量 ${result.name} 未设置，无法解析${fieldLabel}`,
      };
    case "empty":
      return {
        ok: false,
        message: `环境变量 ${result.name} 为空，无法解析${fieldLabel}`,
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function resolveSecretFields(
  raw: Record<string, unknown>,
  env: NormalizeWidgetEnv,
  fieldNames: readonly string[],
): { ok: true; secrets: Record<string, string> } | { ok: false; message: string } {
  const secrets: Record<string, string> = {};
  for (const name of fieldNames) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) {
      continue;
    }
    const value = raw[name];
    if (value === undefined || value === null) {
      continue;
    }
    const resolved = resolveSecretString(value, env, secretFieldLabel(name));
    if (!resolved.ok) {
      return { ok: false, message: resolved.message };
    }
    if (resolved.value.length === 0) {
      continue;
    }
    secrets[name] = resolved.value;
  }
  return { ok: true, secrets };
}

function resolveHeaders(
  raw: unknown,
  env: NormalizeWidgetEnv,
):
  | { ok: true; headers: Record<string, string> | undefined }
  | { ok: false; message: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, headers: undefined };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      message: "customapi 的 headers 必须为对象",
    };
  }

  const headers: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const name = headerName.trim();
    if (name.length === 0) {
      continue;
    }
    if (typeof headerValue !== "string") {
      return {
        ok: false,
        message: `customapi 请求头 ${name} 的值必须为字符串`,
      };
    }
    const resolved = resolveSecretString(
      headerValue,
      env,
      `请求头 ${name}`,
    );
    if (!resolved.ok) {
      return { ok: false, message: resolved.message };
    }
    headers[name] = resolved.value;
  }

  return { ok: true, headers: Object.keys(headers).length > 0 ? headers : undefined };
}

export function normalizeCustomApiMethod(
  raw: unknown,
): { ok: true; method: "GET" } | { ok: false; message: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, method: "GET" };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      message: "customapi 仅支持 GET 方法，method 配置无效",
    };
  }
  const method = raw.trim().toUpperCase();
  if (method.length === 0) {
    return { ok: true, method: "GET" };
  }
  if (method === "GET") {
    return { ok: true, method: "GET" };
  }
  return {
    ok: false,
    message: `customapi 首期仅支持 GET，不支持 method=${raw.trim()}`,
  };
}

function normalizeMappings(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const mappings: unknown[] = [];
  for (const item of raw) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      // 去掉可能的 body 等无关键的深拷贝：只保留已知展示/路径字段
      const src = item as Record<string, unknown>;
      const entry: Record<string, unknown> = {};
      if (typeof src["id"] === "string") entry["id"] = src["id"];
      if (typeof src["label"] === "string") entry["label"] = src["label"];
      if (typeof src["field"] === "string") entry["field"] = src["field"];
      if (typeof src["path"] === "string") entry["path"] = src["path"];
      if (typeof src["format"] === "string") entry["format"] = src["format"];
      mappings.push(entry);
    }
  }
  return mappings;
}

/** 按类型收集 secrets 与 options（均不得进入浏览器视图）。 */
function buildTypePayload(
  type: ServiceWidgetType,
  raw: Record<string, unknown>,
  env: NormalizeWidgetEnv,
):
  | { ok: true; secrets: ResolvedSecrets; options: Record<string, unknown> }
  | { ok: false; message: string } {
  if (type === "qbittorrent" || type === "transmission") {
    const secretsResult = resolveSecretFields(raw, env, [
      "username",
      "password",
    ]);
    if (!secretsResult.ok) {
      return secretsResult;
    }
    // 其余未知字段不进入 options（避免泄漏）
    return { ok: true, secrets: secretsResult.secrets, options: {} };
  }

  if (type === "emby") {
    // key 与 apiKey 均可；插值后统一写入 secrets.key（apiKey 别名合并）
    const secrets: Record<string, string> = {};

    if (Object.prototype.hasOwnProperty.call(raw, "key") && raw["key"] != null) {
      const resolved = resolveSecretString(
        raw["key"],
        env,
        secretFieldLabel("key"),
      );
      if (!resolved.ok) {
        return { ok: false, message: resolved.message };
      }
      if (resolved.value.length > 0) {
        secrets["key"] = resolved.value;
      }
    } else if (
      Object.prototype.hasOwnProperty.call(raw, "apiKey") &&
      raw["apiKey"] != null
    ) {
      const resolved = resolveSecretString(
        raw["apiKey"],
        env,
        secretFieldLabel("apiKey"),
      );
      if (!resolved.ok) {
        return { ok: false, message: resolved.message };
      }
      if (resolved.value.length > 0) {
        secrets["key"] = resolved.value;
      }
    }

    if (Object.prototype.hasOwnProperty.call(raw, "token") && raw["token"] != null) {
      const resolved = resolveSecretString(
        raw["token"],
        env,
        secretFieldLabel("token"),
      );
      if (!resolved.ok) {
        return { ok: false, message: resolved.message };
      }
      if (resolved.value.length > 0) {
        secrets["token"] = resolved.value;
      }
    }

    // 展示开关仅进 options（不进浏览器视图）
    const options: Record<string, unknown> = {};
    for (const key of [
      "enableBlocks",
      "enableNowPlaying",
      "enableUser",
      "showEpisodeNumber",
    ] as const) {
      if (typeof raw[key] === "boolean") {
        options[key] = raw[key];
      }
    }
    if (Array.isArray(raw["fields"])) {
      const fields = raw["fields"].filter(
        (f): f is string => typeof f === "string" && f.trim().length > 0,
      );
      if (fields.length > 0) {
        options["fields"] = fields.map((f) => f.trim().toLowerCase());
      }
    }

    return { ok: true, secrets, options };
  }

  // customapi
  const methodResult = normalizeCustomApiMethod(raw["method"]);
  if (!methodResult.ok) {
    return methodResult;
  }

  const headersResult = resolveHeaders(raw["headers"], env);
  if (!headersResult.ok) {
    return headersResult;
  }

  // 其它密钥字段若出现也仅服务端吸收
  const extraSecrets = resolveSecretFields(raw, env, [
    "password",
    "key",
    "apiKey",
    "token",
    "username",
  ]);
  if (!extraSecrets.ok) {
    return extraSecrets;
  }

  const options: Record<string, unknown> = {
    method: methodResult.method,
  };
  if (headersResult.headers !== undefined) {
    options["headers"] = headersResult.headers;
  }
  const mappings = normalizeMappings(raw["mappings"]);
  if (mappings !== undefined) {
    options["mappings"] = mappings;
  }
  // 明确不接受 body / data / payload
  // （即使 YAML 写了也不进入 options）

  return { ok: true, secrets: extraSecrets.secrets, options };
}

function widgetConfigError(
  type: string,
  message: string,
): ServiceWidgetRef {
  return {
    type,
    error: message,
  };
}

function widgetUnsupported(type: string): ServiceWidgetRef {
  return {
    type,
    unsupported: true,
  };
}

export function normalizeServiceWidget(
  source: Record<string, unknown>,
  context: NormalizeWidgetContext,
): ServiceWidgetRef | undefined {
  const list = pickEffectiveWidgetDeclarations(source);
  if (list.length === 0) {
    return undefined;
  }

  const selected = findFirstSupportedWidget(list);
  if (selected === null) {
    const first = findFirstTypedWidget(list);
    if (first === null) {
      // 有 widgets 数组但无有效 type：标记通用暂不支持
      return widgetUnsupported("unknown");
    }
    return widgetUnsupported(first.type);
  }

  const { widgetIndex, raw, type } = selected;

  const urlRaw = raw["url"];
  if (typeof urlRaw !== "string") {
    return widgetConfigError(type, "服务组件 url 无效或缺失，须为绝对 http(s) URL");
  }
  const targetUrl = normalizeAbsoluteHttpUrl(urlRaw);
  if (targetUrl === null) {
    return widgetConfigError(type, "服务组件 url 无效或缺失，须为绝对 http(s) URL");
  }

  const payload = buildTypePayload(type, raw, context.env);
  if (!payload.ok) {
    return widgetConfigError(type, payload.message);
  }

  const widgetId = buildWidgetId({
    groupIndex: context.groupIndex,
    serviceIndex: context.serviceIndex,
    widgetIndex,
    widgetType: type,
    targetUrl,
  });

  if (context.allowList !== undefined) {
    const target: WidgetTarget = {
      type,
      url: targetUrl,
      secrets: payload.secrets,
      options: payload.options,
    };
    context.allowList.widgetTargets.set(widgetId, target);
  }

  return {
    type,
    widgetId,
  };
}

/** 供测试：密钥字段名列表 */
export const WIDGET_SECRET_FIELD_NAMES = SECRET_FIELD_NAMES;
