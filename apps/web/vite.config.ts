import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const apiProxyTarget =
  process.env["VITE_API_PROXY_TARGET"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 生产镜像不需要浏览器 sourcemap，可省约 2MB+
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: Number(process.env["PORT"]) || 5173,
    strictPort: Boolean(process.env["PORT"]),
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      "/images": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      "/icons": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
