import { LineCounter, parseDocument, YAMLError } from "yaml";

import type { ConfigFileName } from "./constants.js";
import { createConfigValidationError, type ConfigValidationError } from "./errors.js";

export type ParsedYamlDocument = {
  fileName: ConfigFileName;

  value: unknown;
};

function formatYamlErrorReason(error: YAMLError): string {
  const raw = error.message.replace(/\s+/g, " ").trim();
  // yaml 包消息常为英文；包装为中文主句，保留定位细节
  if (raw.length === 0) {
    return "存在无法解析的 YAML 内容";
  }
  return raw;
}

function positionFromYamlError(
  error: YAMLError,
  lineCounter: LineCounter,
): { line?: number; column?: number } {
  const pos = error.pos;
  if (pos === undefined || pos === null) {
    return {};
  }
  const offset = Array.isArray(pos) ? pos[0] : undefined;
  if (typeof offset !== "number" || offset < 0) {
    return {};
  }
  try {
    const { line, col } = lineCounter.linePos(offset);
    const result: { line?: number; column?: number } = {};
    if (line >= 1) result.line = line;
    if (col >= 1) result.column = col;
    return result;
  } catch {
    return {};
  }
}

export function yamlSyntaxErrorToValidationError(
  fileName: ConfigFileName | string,
  error: YAMLError,
  lineCounter: LineCounter,
): ConfigValidationError {
  const { line, column } = positionFromYamlError(error, lineCounter);
  const reason = formatYamlErrorReason(error);
  const locationParts: string[] = [];
  if (line !== undefined) locationParts.push(`第 ${line} 行`);
  if (column !== undefined) locationParts.push(`第 ${column} 列`);
  const locationSuffix =
    locationParts.length > 0 ? `（${locationParts.join("、")}）` : "";

  return createConfigValidationError(
    `配置文件 ${fileName} YAML 语法错误${locationSuffix}：${reason}`,
    {
      file: fileName,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    },
  );
}

export function parseYamlFileContent(
  fileName: ConfigFileName,
  content: string,
): ParsedYamlDocument {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { fileName, value: null };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(content, {
    lineCounter,
    prettyErrors: true,
    strict: false,
    uniqueKeys: true,
  });

  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    if (first) {
      throw yamlSyntaxErrorToValidationError(fileName, first, lineCounter);
    }
    throw createConfigValidationError(
      `配置文件 ${fileName} YAML 语法错误：无法解析`,
      { file: fileName },
    );
  }

  const value = doc.toJS({ maxAliasCount: 100 }) as unknown;
  return { fileName, value };
}

export function assertTopLevelMappingOrEmpty(
  fileName: ConfigFileName,
  value: unknown,
  options?: { allowArray?: boolean },
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    if (options?.allowArray) {
      return;
    }
    throw createConfigValidationError(
      `配置文件 ${fileName} 顶层结构无效：期望映射对象，实际为数组`,
      { file: fileName, path: "$" },
    );
  }
  if (typeof value !== "object") {
    const kind =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "数组"
          : typeof value === "string"
            ? "字符串"
            : typeof value === "number"
              ? "数字"
              : typeof value === "boolean"
                ? "布尔值"
                : typeof value;
    throw createConfigValidationError(
      `配置文件 ${fileName} 顶层结构无效：期望映射对象，实际为${kind}`,
      { file: fileName, path: "$" },
    );
  }
}

export function assertTopLevelGroupsDocument(
  fileName: ConfigFileName,
  value: unknown,
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    return;
  }
  if (typeof value === "object") {
    // 空对象或映射形式：后续规范化再细拆；此处仅拒绝非对象标量
    return;
  }
  const kind =
    typeof value === "string"
      ? "字符串"
      : typeof value === "number"
        ? "数字"
        : typeof value === "boolean"
          ? "布尔值"
          : typeof value;
  throw createConfigValidationError(
    `配置文件 ${fileName} 顶层结构无效：期望分组数组或映射对象，实际为${kind}`,
    { file: fileName, path: "$" },
  );
}

export function assertTopLevelWidgetsDocument(
  fileName: ConfigFileName,
  value: unknown,
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value) || typeof value === "object") {
    return;
  }
  const kind =
    typeof value === "string"
      ? "字符串"
      : typeof value === "number"
        ? "数字"
        : typeof value === "boolean"
          ? "布尔值"
          : typeof value;
  throw createConfigValidationError(
    `配置文件 ${fileName} 顶层结构无效：期望数组或映射对象，实际为${kind}`,
    { file: fileName, path: "$" },
  );
}

export function assertTopLevelDockerDocument(
  fileName: ConfigFileName,
  value: unknown,
): void {
  assertTopLevelMappingOrEmpty(fileName, value, { allowArray: false });
}

export function assertTopLevelSettingsDocument(
  fileName: ConfigFileName,
  value: unknown,
): void {
  assertTopLevelMappingOrEmpty(fileName, value, { allowArray: false });
}

export function assertTopLevelStructure(
  fileName: ConfigFileName,
  value: unknown,
): void {
  switch (fileName) {
    case "settings.yaml":
      assertTopLevelSettingsDocument(fileName, value);
      break;
    case "services.yaml":
    case "bookmarks.yaml":
      assertTopLevelGroupsDocument(fileName, value);
      break;
    case "widgets.yaml":
      assertTopLevelWidgetsDocument(fileName, value);
      break;
    case "docker.yaml":
      assertTopLevelDockerDocument(fileName, value);
      break;
    default: {
      const _exhaustive: never = fileName;
      void _exhaustive;
    }
  }
}

export function unreadableFileToValidationError(
  fileName: ConfigFileName,
  cause: unknown,
): ConfigValidationError {
  const detail =
    cause instanceof Error && cause.message.trim().length > 0
      ? cause.message.trim()
      : "未知 I/O 错误";
  return createConfigValidationError(
    `配置文件 ${fileName} 无法读取：${detail}`,
    { file: fileName },
  );
}
