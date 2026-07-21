/**
 * 跨进程稳定 ID 计算子进程。
 *
 * 用法：node compute-ids-worker.mjs <fixture.json 路径>
 * 从已构建的 `@homepage/domain` 包导入构建器，向 stdout 打印四类 ID 的 JSON。
 *
 * 说明：依赖 packages/domain/dist 已构建；由集成测试在调用前确保 build。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const domainEntry = resolve(__dirname, "../dist/index.js");

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("用法: node compute-ids-worker.mjs <fixture.json>");
  process.exit(2);
}

const fixtureRaw = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureRaw);

const domain = await import(pathToFileURL(domainEntry).href);
const {
  assignStableIdsFromFixture,
  serializeFourIdSets,
} = domain;

if (typeof assignStableIdsFromFixture !== "function") {
  console.error("domain 包未导出 assignStableIdsFromFixture，请先 pnpm --filter @homepage/domain build");
  process.exit(3);
}

const result = assignStableIdsFromFixture(fixture);
const payload = {
  ids: serializeFourIdSets(result.ids),
  canonicals: [...result.canonicals],
};

// 仅输出 JSON 一行，便于父进程解析
process.stdout.write(`${JSON.stringify(payload)}\n`);
