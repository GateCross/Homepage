/**
 * 配置加载入口：读取五文件、规范化并构建 AllowList。
 * - services 规范化与稳定 widgetId（密钥仅 AllowList）
 * - widgets.yaml 信息组件规范化与稳定 infoId（目标仅 AllowList.infoTargets）
 */
import type { NormalizedConfig } from "@homepage/domain";

import type { AllowList } from "./allowlist.js";
import { assertSafeNormalizedConfig } from "./assert-safe-config.js";
import type { ConfigFileName } from "./constants.js";
import { createEmptyLoadResult, createEmptyNormalizedConfig } from "./empty.js";
import { isConfigValidationError } from "./errors.js";
import { normalizeBookmarks } from "./normalize-bookmarks.js";
import { registerDockerEndpoints } from "./normalize-docker.js";
import { normalizeInfoWidgets } from "./normalize-info.js";
import { normalizeServices } from "./normalize-services.js";
import { normalizeSettings } from "./normalize-settings.js";
import {
  assertTopLevelStructure,
  parseYamlFileContent,
  unreadableFileToValidationError,
} from "./parse-yaml.js";
import {
  areAllConfigFilesMissing,
  readAllConfigFiles,
  resolveConfigDir,
  type FiveConfigFiles,
} from "./read-files.js";

export type LoadConfigOptions = {

  configDir?: string;

  env?: NodeJS.ProcessEnv;
};

/** 单次 loadConfig 的结果：浏览器安全视图 + 仅服务端可见的当次 AllowList。 调用方不得跨请求复用 allowList 作为全局授权真相。 */
export type LoadConfigResult = {
  config: NormalizedConfig;
  allowList: AllowList;
};

export type ParsedConfigSources = {
  settings: unknown | undefined;
  services: unknown | undefined;
  bookmarks: unknown | undefined;
  widgets: unknown | undefined;
  docker: unknown | undefined;

  presentFiles: ConfigFileName[];

  missingFiles: ConfigFileName[];
};

export async function readAndParseConfigSources(
  options: LoadConfigOptions = {},
): Promise<{ configDir: string; files: FiveConfigFiles; sources: ParsedConfigSources }> {
  const configDir = resolveConfigDir(options.configDir, options.env ?? process.env);
  const files = await readAllConfigFiles(configDir);

  const sources: ParsedConfigSources = {
    settings: undefined,
    services: undefined,
    bookmarks: undefined,
    widgets: undefined,
    docker: undefined,
    presentFiles: [],
    missingFiles: [],
  };

  const assign = (fileName: ConfigFileName, value: unknown): void => {
    switch (fileName) {
      case "settings.yaml":
        sources.settings = value;
        break;
      case "services.yaml":
        sources.services = value;
        break;
      case "bookmarks.yaml":
        sources.bookmarks = value;
        break;
      case "widgets.yaml":
        sources.widgets = value;
        break;
      case "docker.yaml":
        sources.docker = value;
        break;
      default: {
        const _exhaustive: never = fileName;
        void _exhaustive;
      }
    }
  };

  for (const fileName of [
    "settings.yaml",
    "services.yaml",
    "bookmarks.yaml",
    "widgets.yaml",
    "docker.yaml",
  ] as const) {
    const file = files[fileName];
    if (file.status === "missing") {
      sources.missingFiles.push(fileName);
      continue;
    }
    if (file.status === "unreadable") {
      throw unreadableFileToValidationError(fileName, file.cause);
    }

    const parsed = parseYamlFileContent(fileName, file.content);
    assertTopLevelStructure(fileName, parsed.value);
    // null / 空文档：视为该类别「存在但为空」，与缺失一样用默认空值
    assign(fileName, parsed.value);
    sources.presentFiles.push(fileName);
  }

  return { configDir, files, sources };
}

/** 视图，确保不含 AllowList 中的密钥 / 请求头值 数据 API 每次请求都应调用本函数并用**当次** AllowList 鉴权。 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadConfigResult> {
  const { files, sources } = await readAndParseConfigSources(options);

  if (areAllConfigFilesMissing(files)) {
    // 空仪表盘已由 schema 构造；AllowList 为空，无需密钥扫描
    return createEmptyLoadResult();
  }

  const base = createEmptyNormalizedConfig();
  // 每次 loadConfig 新建 AllowList，不复用进程内全局状态
  const { allowList } = createEmptyLoadResult();

  // 先登记 docker 端点，再规范化 services（容器登记依赖已声明端点）
  registerDockerEndpoints(sources.docker, allowList);

  const env = options.env ?? process.env;

  const draft: NormalizedConfig = {
    ...base,
    settings: normalizeSettings(sources.settings),
    services: normalizeServices(sources.services, { allowList, env }),
    bookmarks: normalizeBookmarks(sources.bookmarks),
    infoWidgets: normalizeInfoWidgets(sources.widgets, { allowList }),
  };

  const config = assertSafeNormalizedConfig(draft, allowList);

  return {
    config,
    allowList,
  };
}

export { isConfigValidationError, resolveConfigDir };
