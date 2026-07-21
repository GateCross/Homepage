import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CONFIG_DIR_ENV,
  CONFIG_FILE_NAMES,
  DEFAULT_CONFIG_DIR_NAME,
  type ConfigFileName,
} from "./constants.js";

export type ConfigFileReadResult =
  | { status: "missing"; fileName: ConfigFileName; absolutePath: string }
  | {
      status: "ok";
      fileName: ConfigFileName;
      absolutePath: string;

      content: string;
    }
  | {
      status: "unreadable";
      fileName: ConfigFileName;
      absolutePath: string;
      cause: unknown;
    };

export type FiveConfigFiles = Record<ConfigFileName, ConfigFileReadResult>;

export function resolveConfigDir(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return path.resolve(explicit.trim());
  }
  const fromEnv = env[CONFIG_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  return path.resolve(process.cwd(), DEFAULT_CONFIG_DIR_NAME);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

export async function readConfigFile(
  configDir: string,
  fileName: ConfigFileName,
): Promise<ConfigFileReadResult> {
  const absolutePath = path.join(configDir, fileName);
  try {
    const content = await readFile(absolutePath, "utf8");
    return { status: "ok", fileName, absolutePath, content };
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return { status: "missing", fileName, absolutePath };
    }
    return { status: "unreadable", fileName, absolutePath, cause: error };
  }
}

export async function readAllConfigFiles(
  configDir: string,
): Promise<FiveConfigFiles> {
  const results = await Promise.all(
    CONFIG_FILE_NAMES.map((name) => readConfigFile(configDir, name)),
  );

  const map = {} as FiveConfigFiles;
  for (const result of results) {
    map[result.fileName] = result;
  }
  return map;
}

export function areAllConfigFilesMissing(files: FiveConfigFiles): boolean {
  return CONFIG_FILE_NAMES.every((name) => files[name].status === "missing");
}
