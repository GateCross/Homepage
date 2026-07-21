import process from "node:process";

import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { resolveServerEnv } from "./env.js";
import { logError, logInfo } from "./log.js";

const PACKAGE_NAME = "@homepage/server" as const;

async function main(): Promise<void> {
  try {
    const env = resolveServerEnv();
    const { app } = createApp({
      env,
      webDistDir: false,
      requireWebDist: false,
    });

    const server = serve({
      fetch: app.fetch,
      port: env.port,
      hostname: env.host,
    });

    const displayHost =
      env.host === "0.0.0.0" || env.host === "::" ? "127.0.0.1" : env.host;
    const url = `http://${displayHost}:${env.port}/`;

    logInfo(
      PACKAGE_NAME,
      `[dev] 已监听 ${env.host}:${env.port} → ${url}（仅 API，前端请用 Vite）`,
    );
    logInfo(PACKAGE_NAME, `[dev] CONFIG_DIR=${env.configDir}`);

    const close = (): Promise<void> =>
      new Promise((resolve, reject) => {
        server.close((err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      });

    const shutdown = async (signal: string) => {
      logInfo(PACKAGE_NAME, `收到 ${signal}，正在关闭…`);
      try {
        await close();
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(PACKAGE_NAME, `关闭失败：${message}`);
        process.exit(1);
      }
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(PACKAGE_NAME, `启动失败：${message}`);
    process.exit(1);
  }
}

void main();
