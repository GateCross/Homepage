import path from "node:path";
import { defineConfig } from "vitest/config";

import { dashboardTestProjects } from "./apps/web/vitest.projects";

const root = import.meta.dirname;
const alias = { "@": path.resolve(root, "apps/web/src") };

/**
 * 全仓单测入口：分流规则收敛在 apps/web/vitest.projects.ts，
 * 纯函数与契约浅校验跑 node，组件测试跑 jsdom。
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: dashboardTestProjects(alias, "apps/web/src"),
  },
});
