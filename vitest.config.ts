import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;
const alias = { "@": path.resolve(root, "apps/web/src") };

/**
 * 前端单测分两个 project：纯函数与契约浅校验跑 node，
 * 组件测试跑 jsdom。按后缀分流，不需要 DOM 的用例不付 jsdom 启动成本。
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          include: ["apps/web/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "dom",
          include: ["apps/web/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["apps/web/src/test-setup.ts"],
        },
      },
    ],
  },
});
