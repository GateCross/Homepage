import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { ADAPTERS_PACKAGE_NAME } from "@homepage/adapters";
import { CONFIG_PACKAGE_NAME } from "@homepage/config";
import { DOMAIN_PACKAGE_NAME } from "@homepage/domain";

import { createApp } from "./app.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  resolveHost,
  resolvePort,
  resolveServerEnv,
  type ServerEnv,
} from "./env.js";
import { logError, logInfo } from "./log.js";

export const SERVER_PACKAGE_NAME = "@homepage/server" as const;

export const SERVER_BOUNDARY = {
  packageName: SERVER_PACKAGE_NAME,
  dependsOn: [
    DOMAIN_PACKAGE_NAME,
    CONFIG_PACKAGE_NAME,
    ADAPTERS_PACKAGE_NAME,
  ] as const,
  role: "api-proxy-docker-static",
} as const;

export {
  ADAPTERS_PACKAGE_NAME,
  CONFIG_PACKAGE_NAME,
  DOMAIN_PACKAGE_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  resolveHost,
  resolvePort,
  resolveServerEnv,
  createApp,
};

export type { ServerEnv };

export type ListenOptions = {
  port?: number;
  host?: string;
  configDir?: string;
};

export type StartedServer = {
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
};

export function resolveListenOptions(
  overrides: ListenOptions = {},
): Required<Pick<ListenOptions, "port" | "host">> & { configDir: string } {
  const env = resolveServerEnv({
    ...(overrides.port !== undefined ? { port: overrides.port } : {}),
    ...(overrides.host !== undefined ? { host: overrides.host } : {}),
    ...(overrides.configDir !== undefined
      ? { configDir: overrides.configDir }
      : {}),
  });
  return {
    port: env.port,
    host: env.host,
    configDir: env.configDir,
  };
}

export async function startServer(
  options: ListenOptions = {},
): Promise<StartedServer> {
  const listen = resolveListenOptions(options);
  const { app, env } = createApp({
    env: {
      port: listen.port,
      host: listen.host,
      configDir: listen.configDir,
    },
    requireWebDist: true,
  });

  const server = serve({
    fetch: app.fetch,
    port: env.port,
    hostname: env.host,
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  const displayHost =
    env.host === "0.0.0.0" || env.host === "::" ? "127.0.0.1" : env.host;

  return {
    port: env.port,
    host: env.host,
    url: `http://${displayHost}:${env.port}/`,
    close,
  };
}

export function isMainModule(
  metaUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    const thisFile = path.resolve(fileURLToPath(metaUrl));
    const invoked = path.resolve(argv1);
    return thisFile === invoked;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    const started = await startServer();
    logInfo(
      SERVER_PACKAGE_NAME,
      `已监听 ${started.host}:${started.port} → ${started.url}`,
    );

    const shutdown = async (signal: string) => {
      logInfo(SERVER_PACKAGE_NAME, `收到 ${signal}，正在关闭…`);
      try {
        await started.close();
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(SERVER_PACKAGE_NAME, `关闭失败：${message}`);
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
    logError(SERVER_PACKAGE_NAME, `启动失败：${message}`);
    process.exit(1);
  }
}

if (isMainModule()) {
  void main();
}

// 子模块再导出，便于测试与扩展
export {
  authorizeDockerLookup,
  queryDockerStatus,
} from "./docker/status.js";
export {
  createDockerClient,
  createDockerTransport,
  mapInspectToStatus,
} from "./docker/client.js";
export {
  fetchOpenMeteoInfo,
  parseOpenMeteoTargetOptions,
  weatherCodeToConditionText,
} from "./providers/openmeteo.js";
export {
  collectResourcesInfo,
  createDefaultResourcesCollector,
  parseResourcesTargetOptions,
} from "./providers/resources.js";
export { runHttpProbe } from "./probe.js";
export { redactSecretsInText, redactValue } from "./log.js";
