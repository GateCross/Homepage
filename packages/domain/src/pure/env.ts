/** 密钥整值环境变量插值（属性 13 / 需求 3.7、3.8）。 仅当**整个值**严格匹配 `${ENV_VAR}` 时替换； 嵌入型如 `Bearer ${TOKEN}` 保持原样不插值。 ENV_ */
export const WHOLE_ENV_PLACEHOLDER_RE = /^\$\{([A-Z0-9_]+)\}$/;

export type InterpolateEnvResult =
  | {
      kind: "unchanged";
      value: string;
    }
  | {

      kind: "resolved";
      name: string;
      value: string;
    }
  | {

      kind: "missing";
      name: string;
    }
  | {

      kind: "empty";
      name: string;
    };

export function interpolateEnvWholeValue(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): InterpolateEnvResult {
  const match = WHOLE_ENV_PLACEHOLDER_RE.exec(value);
  if (!match) {
    return { kind: "unchanged", value };
  }

  const name = match[1] as string;
  if (!Object.prototype.hasOwnProperty.call(env, name) || env[name] === undefined) {
    return { kind: "missing", name };
  }

  const resolved = env[name] as string;
  if (resolved === "") {
    return { kind: "empty", name };
  }

  return { kind: "resolved", name, value: resolved };
}

export function isWholeEnvPlaceholder(value: string): boolean {
  return WHOLE_ENV_PLACEHOLDER_RE.test(value);
}
