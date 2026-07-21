/** 日志脱敏：避免密钥、Cookie、token 等完整敏感值进入应用日志。 */
export const REDACTED = "[已脱敏]" as const;

const SENSITIVE_KEY_RE =
  /pass(word)?|secret|token|api[_-]?key|authorization|cookie|sid|credential|private/i;

export function redactSecretsInText(
  text: string,
  secrets: readonly string[],
): string {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) {
      continue;
    }
    if (!result.includes(secret)) {
      continue;
    }
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

export function redactValue(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactSecretsInText(value, secrets);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(child, secrets);
      }
    }
    return out;
  }
  return String(value);
}

export function logError(
  scope: string,
  message: string,
  secrets: readonly string[] = [],
  detail?: unknown,
): void {
  const safeMessage = redactSecretsInText(message, secrets);
  const line =
    detail === undefined
      ? `[${scope}] ${safeMessage}\n`
      : `[${scope}] ${safeMessage} ${JSON.stringify(redactValue(detail, secrets))}\n`;
  process.stderr.write(line);
}

export function logInfo(
  scope: string,
  message: string,
  secrets: readonly string[] = [],
): void {
  process.stdout.write(
    `[${scope}] ${redactSecretsInText(message, secrets)}\n`,
  );
}
