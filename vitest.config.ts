import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

/** 前端单测：只跑纯函数与契约浅校验，不需要 DOM。 */
export default defineConfig({
  test: {
    include: ["apps/web/src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "apps/web/src"),
    },
  },
});
