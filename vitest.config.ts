import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@homepage/domain": path.resolve(root, "packages/domain/src/index.ts"),
      "@homepage/config": path.resolve(root, "packages/config/src/index.ts"),
      "@homepage/adapters": path.resolve(root, "packages/adapters/src/index.ts"),
      "@homepage/server": path.resolve(root, "packages/server/src/index.ts"),
    },
  },
});
