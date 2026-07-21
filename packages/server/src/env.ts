import process from "node:process";

import { resolveConfigDir } from "@homepage/config";

export const DEFAULT_PORT = 3000;

export const DEFAULT_HOST = "0.0.0.0";

export type ServerEnv = {
  configDir: string;
  port: number;
  host: string;
};

export function resolvePort(
  raw: string | undefined = process.env["PORT"],
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return DEFAULT_PORT;
  }
  return n;
}

export function resolveHost(
  raw: string | undefined = process.env["HOST"],
): string {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_HOST;
  }
  return raw.trim();
}

export function resolveServerEnv(
  overrides: Partial<ServerEnv> = {},
): ServerEnv {
  return {
    configDir:
      overrides.configDir ??
      resolveConfigDir(undefined, process.env),
    port: overrides.port ?? resolvePort(),
    host: overrides.host ?? resolveHost(),
  };
}
