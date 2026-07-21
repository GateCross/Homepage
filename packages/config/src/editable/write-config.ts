import type {
  ConfigWriteSuccessResponse,
  EditableConfigWrite,
} from "@homepage/domain";

import type { ConfigFileName } from "../constants.js";
import {
  loadConfig,
  readAndParseConfigSources,
  type LoadConfigOptions,
} from "../load-config.js";
import { resolveConfigDir } from "../read-files.js";
import { configFaultGate } from "./fault-gate.js";
import {
  CONFIG_SAVE_FAILED_MESSAGE,
  createConfigFaultedError,
  createFieldValidationError,
} from "./helpers.js";
import { mergeEditableIntoSources } from "./merge-sources.js";
import { editableToFiveYamlDocuments } from "./serialize.js";
import {
  cleanupPrepared,
  prepareAndValidateFiveFiles,
  replaceFiveFiles,
  rollbackReplacedFiles,
  snapshotFiveFiles,
  type FiveFileSnapshot,
  type PreparedFiveFiles,
} from "./snapshot-rollback.js";
import { parseEditableConfigWrite } from "./validate-write.js";
import { configWriteLock } from "./write-lock.js";

export type WriteConfigOptions = LoadConfigOptions;

export type WriteConfigResult = ConfigWriteSuccessResponse;

/**
 * 完整写回入口：
 * 载荷解析 → 加锁 → 原始树保留合并 → 候选完整加载 →
 * 旧快照 → 五文件替换 → 正式目录完整加载 → 必要回滚 / 故障闸门。
 */
export async function writeConfig(
  body: unknown,
  options: WriteConfigOptions = {},
): Promise<WriteConfigResult> {
  if (configFaultGate.isFaulted()) {
    const recovered = await configFaultGate.tryRecover(options);
    if (!recovered) {
      configFaultGate.assertOpen();
    }
  }

  const payload = parseEditableConfigWrite(body);

  return configWriteLock.run(() => writeConfigLocked(payload, options));
}

async function writeConfigLocked(
  payload: EditableConfigWrite,
  options: WriteConfigOptions,
): Promise<WriteConfigResult> {
  if (configFaultGate.isFaulted()) {
    const recovered = await configFaultGate.tryRecover(options);
    if (!recovered) {
      throw createConfigFaultedError();
    }
  }

  const configDir = resolveConfigDir(
    options.configDir,
    options.env ?? process.env,
  );
  let prepared: PreparedFiveFiles | null = null;
  let snapshot: FiveFileSnapshot | null = null;
  let replaced: ConfigFileName[] = [];
  let committed = false;

  try {
    const { sources } = await readAndParseConfigSources({
      ...options,
      configDir,
    });

    const merged = mergeEditableIntoSources(payload, sources);
    const yamlTexts = editableToFiveYamlDocuments(merged);

    prepared = await prepareAndValidateFiveFiles(yamlTexts, options);
    snapshot = await snapshotFiveFiles(configDir);

    const replaceResult = await replaceFiveFiles(configDir, prepared);
    replaced = replaceResult.replaced;

    try {
      await loadConfig({
        ...options,
        configDir,
      });
    } catch {
      await rollbackAndVerify(configDir, snapshot, replaced, options);
      replaced = [];
      throw createFieldValidationError(CONFIG_SAVE_FAILED_MESSAGE, {});
    }

    committed = true;
    return { ok: true as const };
  } catch (err) {
    if (!committed && snapshot !== null && replaced.length > 0) {
      try {
        await rollbackAndVerify(configDir, snapshot, replaced, options);
        replaced = [];
      } catch {
        // rollbackAndVerify 已开启故障闸门
      }
    }
    throw err;
  } finally {
    await cleanupPrepared(prepared);
  }
}

async function rollbackAndVerify(
  configDir: string,
  snapshot: FiveFileSnapshot,
  replaced: readonly ConfigFileName[],
  options: WriteConfigOptions,
): Promise<void> {
  try {
    await rollbackReplacedFiles(configDir, snapshot, replaced);
  } catch {
    configFaultGate.open(
      "配置回滚失败，已进入故障状态。请手动恢复配置五文件",
    );
    throw createConfigFaultedError();
  }

  try {
    await loadConfig({
      ...options,
      configDir,
    });
  } catch {
    configFaultGate.open(
      "配置回滚后验证失败，已进入故障状态。请手动恢复配置五文件",
    );
    throw createConfigFaultedError();
  }
}
