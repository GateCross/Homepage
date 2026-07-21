import {
  NormalizedConfigSchema,
  type NormalizedConfig,
} from "@homepage/domain";

import type { AllowList } from "./allowlist.js";
import { createConfigValidationError } from "./errors.js";

const SAFE_VIEW_LOCATION = {
  file: "normalized-config",
} as const;

const SCHEMA_FAIL_MESSAGE =
  "规范化配置未通过运行时校验，请检查配置结构后重试";

const SECRET_LEAK_MESSAGE =
  "安全视图校验失败：公开配置不得包含密钥或敏感凭证";

/** 过短串易与公开 JSON 误匹配，仅在安全视图扫描时跳过 */
const MIN_PUBLIC_SCAN_LENGTH = 4;

/** 收集 secrets 与 headers 全部非空值（供日志脱敏）；出站 URL 本身不扫。 */
export function collectSensitiveValues(allowList: AllowList): string[] {
  const values = new Set<string>();

  for (const target of allowList.widgetTargets.values()) {
    for (const secret of Object.values(target.secrets)) {
      if (typeof secret === "string" && secret.length > 0) {
        values.add(secret);
      }
    }

    const options = target.options;
    if (
      options !== null &&
      options !== undefined &&
      typeof options === "object" &&
      !Array.isArray(options)
    ) {
      const headers = (options as Record<string, unknown>)["headers"];
      if (
        headers !== null &&
        headers !== undefined &&
        typeof headers === "object" &&
        !Array.isArray(headers)
      ) {
        for (const headerValue of Object.values(
          headers as Record<string, unknown>,
        )) {
          if (typeof headerValue === "string" && headerValue.length > 0) {
            values.add(headerValue);
          }
        }
      }
    }
  }

  return [...values];
}

/** 同时匹配原文与 JSON 转义形式，避免引号/反斜杠漏检。 */
export function publicJsonContainsSecret(
  publicJson: string,
  secret: string,
): boolean {
  if (secret.length === 0) {
    return false;
  }
  if (publicJson.includes(secret)) {
    return true;
  }
  const escapedBody = JSON.stringify(secret).slice(1, -1);
  return escapedBody !== secret && publicJson.includes(escapedBody);
}

export function assertSafeNormalizedConfig(
  config: unknown,
  allowList: AllowList,
): NormalizedConfig {
  let parsed: NormalizedConfig;
  try {
    parsed = NormalizedConfigSchema.parse(config);
  } catch {
    throw createConfigValidationError(SCHEMA_FAIL_MESSAGE, SAFE_VIEW_LOCATION);
  }

  const sensitiveValues = collectSensitiveValues(allowList).filter(
    (s) => s.length >= MIN_PUBLIC_SCAN_LENGTH,
  );
  if (sensitiveValues.length === 0) {
    return parsed;
  }

  const publicJson = JSON.stringify(parsed);
  for (const secret of sensitiveValues) {
    if (publicJsonContainsSecret(publicJson, secret)) {
      throw createConfigValidationError(SECRET_LEAK_MESSAGE, SAFE_VIEW_LOCATION);
    }
  }

  return parsed;
}
