import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_FILE_NAMES, type ConfigFileName } from "../constants.js";
import {
  ConfigReplaceFailedError,
  replaceFiveFiles,
  rollbackReplacedFiles,
  snapshotFiveFiles,
  type PreparedFiveFiles,
} from "./snapshot-rollback.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hp-cfg-"));
  tempDirs.push(dir);
  return dir;
}

async function seedFiveFiles(
  configDir: string,
  contents: Partial<Record<ConfigFileName, string>>,
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  for (const name of CONFIG_FILE_NAMES) {
    const text = contents[name] ?? `# old ${name}\n`;
    await writeFile(path.join(configDir, name), text, "utf8");
  }
}

async function prepareTexts(
  texts: Record<ConfigFileName, string>,
): Promise<PreparedFiveFiles> {
  const tempDir = await makeTempDir();
  const files = {} as PreparedFiveFiles["files"];
  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.join(tempDir, name);
    await writeFile(filePath, texts[name], "utf8");
    files[name] = filePath;
  }
  return { tempDir, files };
}

describe("replaceFiveFiles 部分失败", () => {
  it("中途失败时抛出带已替换列表的错误，调用方可回滚到快照", async () => {
    const configDir = await makeTempDir();
    await seedFiveFiles(configDir, {
      "settings.yaml": "title: old\n",
      "services.yaml": "[]\n",
      "bookmarks.yaml": "[]\n",
      "widgets.yaml": "[]\n",
      "docker.yaml": "{}\n",
    });
    const snapshot = await snapshotFiveFiles(configDir);

    const prepared = await prepareTexts({
      "settings.yaml": "title: new\n",
      "services.yaml": "- Group:\n    - name: a\n",
      "bookmarks.yaml": "[]\n",
      "widgets.yaml": "[]\n",
      "docker.yaml": "{}\n",
    });

    // 将第 3 个准备文件改成目录，迫使 copyFile 失败
    const third = CONFIG_FILE_NAMES[2]!;
    await rm(prepared.files[third], { force: true });
    await mkdir(prepared.files[third]);

    let caught: unknown;
    try {
      await replaceFiveFiles(configDir, prepared);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigReplaceFailedError);
    const failed = caught as ConfigReplaceFailedError;
    expect(failed.replaced.length).toBeGreaterThan(0);
    expect(failed.replaced).not.toContain(third);

    // 已替换文件内容已是新版本（混版）
    const first = failed.replaced[0]!;
    const mixed = await readFile(path.join(configDir, first), "utf8");
    expect(mixed).not.toContain(`# old ${first}`);

    // 用失败前快照回滚已替换列表
    await rollbackReplacedFiles(configDir, snapshot, failed.replaced);
    const restored = await readFile(path.join(configDir, first), "utf8");
    expect(restored).toContain("old");
  });
});
