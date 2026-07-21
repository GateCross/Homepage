import {
  EditableConfigWriteSchema,
  type EditableConfigWrite,
} from "@homepage/domain";

import {
  createDockerConnectionSensitiveError,
  createFieldValidationError,
  dockerConnectionHasUserInfo,
} from "./helpers.js";

const BYPASS_KEYS = new Set([
  "allowList",
  "secrets",
  "resolvedSecrets",
  "resolved",
  "clientMeta",
]);

/**
 * 解析写回载荷：剔除旁路字段，zod 校验，拒绝含 userinfo 的 Docker 连接串。
 */
export function parseEditableConfigWrite(body: unknown): EditableConfigWrite {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw createFieldValidationError("写回载荷必须为对象", {
      path: "$",
    });
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (BYPASS_KEYS.has(key)) continue;
    if (key.startsWith("resolved")) continue;
    cleaned[key] = value;
  }

  const parsed = EditableConfigWriteSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path =
      issue !== undefined && issue.path.length > 0
        ? issue.path.map(String).join(".")
        : undefined;
    throw createFieldValidationError(
      issue?.message
        ? `写回载荷校验失败：${issue.message}`
        : "写回载荷校验失败",
      path !== undefined ? { path } : {},
    );
  }

  for (let i = 0; i < parsed.data.dockerEndpoints.length; i += 1) {
    const ep = parsed.data.dockerEndpoints[i];
    if (ep === undefined) continue;
    if (dockerConnectionHasUserInfo(ep.connection)) {
      throw createDockerConnectionSensitiveError(
        `dockerEndpoints.${i}.connection`,
      );
    }
  }

  return parsed.data;
}
