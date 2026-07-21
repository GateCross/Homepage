import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConfigFileName } from "../constants.js";
import { CONFIG_FILE_NAMES } from "../constants.js";
import { loadConfig, type LoadConfigOptions } from "../load-config.js";
import { createFieldValidationError, CONFIG_SAVE_FAILED_MESSAGE } from "./helpers.js";
import type { FiveYamlTexts } from "./serialize.js";

export type FileSnapshotEntry =
  | { exists: true; content: Buffer }
  | { exists: false };

export type FiveFileSnapshot = Record<ConfigFileName, FileSnapshotEntry>;

export type PreparedFiveFiles = {
  tempDir: string;
  files: Record<ConfigFileName, string>;
};

/** 写回前快照：存在状态 + 完整字节 */
export async function snapshotFiveFiles(
  configDir: string,
): Promise<FiveFileSnapshot> {
  const snapshot = {} as FiveFileSnapshot;
  for (const name of CONFIG_FILE_NAMES) {
    const absolutePath = path.join(configDir, name);
    try {
      const content = await readFile(absolutePath);
      snapshot[name] = { exists: true, content };
    } catch (err) {
      if (isNotFound(err)) {
        snapshot[name] = { exists: false };
      } else {
        throw createFieldValidationError(
          "无法读取配置文件快照，保存已中止",
          { file: name },
        );
      }
    }
  }
  return snapshot;
}

export async function prepareAndValidateFiveFiles(
  yamlTexts: FiveYamlTexts,
  options: LoadConfigOptions = {},
): Promise<PreparedFiveFiles> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "homepage-cfg-"));
  try {
    // 仅当前用户可访问
    await chmod(tempDir, 0o700);

    const files = {} as Record<ConfigFileName, string>;
    for (const name of CONFIG_FILE_NAMES) {
      const filePath = path.join(tempDir, name);
      await writeFile(filePath, yamlTexts[name], { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600);
      files[name] = filePath;
    }

    // 对临时目录完整 loadConfig
    await loadConfig({
      ...options,
      configDir: tempDir,
    });

    return { tempDir, files };
  } catch (err) {
    await safeRm(tempDir);
    throw err;
  }
}

export type ReplaceResult = {
  replaced: ConfigFileName[];
};

/**
 * 持锁逐文件：同目录临时文件 → 原子 rename。
 * 记录已替换文件供失败补偿。
 */
export async function replaceFiveFiles(
  configDir: string,
  prepared: PreparedFiveFiles,
): Promise<ReplaceResult> {
  await mkdir(configDir, { recursive: true });
  const replaced: ConfigFileName[] = [];

  for (const name of CONFIG_FILE_NAMES) {
    const target = path.join(configDir, name);
    const source = prepared.files[name];
    const tempTarget = path.join(
      configDir,
      `.${name}.${process.pid}.${Date.now()}.tmp`,
    );

    try {
      await copyFile(source, tempTarget);
      await chmod(tempTarget, 0o600);
      // 尽量 fsync
      try {
        const fh = await open(tempTarget, "r+");
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
      } catch {
        // 同步失败不阻断
      }
      await rename(tempTarget, target);
      replaced.push(name);
    } catch {
      // 清理本次临时文件
      await safeUnlink(tempTarget);
      throw createFieldValidationError(CONFIG_SAVE_FAILED_MESSAGE, {
        file: name,
      });
    }
  }

  return { replaced };
}

/**
 * 按快照回滚全部已替换文件；原先不存在的恢复为不存在。
 */
export async function rollbackReplacedFiles(
  configDir: string,
  snapshot: FiveFileSnapshot,
  replaced: readonly ConfigFileName[],
): Promise<void> {
  for (const name of replaced) {
    const target = path.join(configDir, name);
    const entry = snapshot[name];
    const tempTarget = path.join(
      configDir,
      `.${name}.rollback.${process.pid}.${Date.now()}.tmp`,
    );

    try {
      if (entry.exists) {
        await writeFile(tempTarget, entry.content, { mode: 0o600 });
        try {
          const fh = await open(tempTarget, "r+");
          try {
            await fh.sync();
          } finally {
            await fh.close();
          }
        } catch {
          // ignore
        }
        await rename(tempTarget, target);
      } else {
        await safeUnlink(target);
      }
    } catch {
      await safeUnlink(tempTarget);
      throw createFieldValidationError(
        "配置回滚失败，已进入故障状态",
        { file: name },
      );
    }
  }
}

export async function cleanupPrepared(prepared: PreparedFiveFiles | null): Promise<void> {
  if (prepared === null) return;
  await safeRm(prepared.tempDir);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

async function safeRm(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // 清理失败仅忽略（不得泄露路径到调用方）
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
}
