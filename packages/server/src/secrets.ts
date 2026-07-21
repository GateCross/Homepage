/** 响应体密钥扫描：发送前确保 JSON 不含 AllowList 中的敏感值。 */
import type { AllowList } from "@homepage/config";
import { collectSensitiveValues, publicJsonContainsSecret } from "@homepage/config";

export function gatherSecrets(
  allowList: AllowList,
  extra: readonly string[] = [],
): string[] {
  const base = collectSensitiveValues(allowList);
  const set = new Set(base);
  for (const item of extra) {
    if (typeof item === "string" && item.length > 0) {
      set.add(item);
    }
  }
  return [...set];
}

export function jsonContainsAnySecret(
  data: unknown,
  secrets: readonly string[],
): boolean {
  if (secrets.length === 0) {
    return false;
  }
  let publicJson: string;
  try {
    publicJson = JSON.stringify(data);
  } catch {
    return true;
  }
  for (const secret of secrets) {
    if (publicJsonContainsSecret(publicJson, secret)) {
      return true;
    }
  }
  return false;
}
