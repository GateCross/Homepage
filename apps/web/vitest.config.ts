import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const alias = { "@": path.resolve(rootDir, "src") };

/**
 * 单包运行用配置：与仓库根 config 保持同一分流规则，
 * 纯函数跑 node，组件测试跑 jsdom。
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "dom",
          include: ["src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["src/test-setup.ts"],
        },
      },
    ],
  },
});
