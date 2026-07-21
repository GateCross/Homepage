import { stringify } from "yaml";

import type { ConfigFileName } from "../constants.js";
import { CONFIG_FILE_NAMES } from "../constants.js";
import type { ParsedConfigSources } from "../load-config.js";
import { createFieldValidationError } from "./helpers.js";

export type FiveYamlTexts = Record<ConfigFileName, string>;

function toYamlText(value: unknown, file: ConfigFileName): string {
  try {
    // null / undefined → 空文档
    if (value === undefined || value === null) {
      return "";
    }
    const text = stringify(value, {
      lineWidth: 0,
      defaultStringType: "PLAIN",
      defaultKeyType: "PLAIN",
    });
    return text.endsWith("\n") ? text : `${text}\n`;
  } catch {
    throw createFieldValidationError(
      `无法安全序列化配置文件 ${file}`,
      { file },
    );
  }
}

/**
 * 从保留合并后的五棵解析树生成 UTF-8 YAML 文本。
 * 保持数组顺序；不添加影响稳定 ID 的隐式字段。
 */
export function editableToFiveYamlDocuments(
  mergedSources: ParsedConfigSources,
): FiveYamlTexts {
  const texts = {
    "settings.yaml": toYamlText(mergedSources.settings, "settings.yaml"),
    "services.yaml": toYamlText(mergedSources.services, "services.yaml"),
    "bookmarks.yaml": toYamlText(mergedSources.bookmarks, "bookmarks.yaml"),
    "widgets.yaml": toYamlText(mergedSources.widgets, "widgets.yaml"),
    "docker.yaml": toYamlText(mergedSources.docker, "docker.yaml"),
  } as FiveYamlTexts;

  for (const name of CONFIG_FILE_NAMES) {
    if (typeof texts[name] !== "string") {
      throw createFieldValidationError(`缺少序列化结果：${name}`, {
        file: name,
      });
    }
  }

  return texts;
}
