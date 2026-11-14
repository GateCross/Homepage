import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { dashboardTestProjects } from "./vitest.projects";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const alias = { "@": path.resolve(rootDir, "src") };

/**
 * 单包运行用配置：分流规则收敛在 vitest.projects.ts，
 * 与仓库根 runner 保持同一套 node / jsdom 分流。
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: dashboardTestProjects(alias, "src"),
  },
});
