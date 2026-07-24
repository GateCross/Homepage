import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { VersionSuccessResponse } from "@homepage/domain";

/** GitHub 仓库（用于 release 检查） */
export const GITHUB_REPO = "GateCross/Homepage" as const;
export const GITHUB_RELEASES_URL =
  `https://github.com/${GITHUB_REPO}/releases` as const;
export const GITHUB_LATEST_RELEASE_API =
  `https://api.github.com/repos/${GITHUB_REPO}/releases/latest` as const;

const CHECK_TIMEOUT_MS = 8_000;
/** 成功结果缓存：避免频繁打 GitHub */
const SUCCESS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 失败结果短缓存：网络/无 release 时尽快可重试 */
const ERROR_CACHE_TTL_MS = 2 * 60 * 1000;

type CachedCheck = {
  expiresAt: number;
  latestVersion: string | undefined;
  releaseUrl: string | undefined;
  checkError: boolean;
};

let cachedCheck: CachedCheck | null = null;
let inflightCheck: Promise<CachedCheck> | null = null;
let memoizedAppVersion: string | null = null;

function resolvePackageJsonPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist → packages/server → monorepo root
  return path.resolve(here, "../../../package.json");
}

export function readAppVersion(
  packageJsonPath: string = resolvePackageJsonPath(),
): string {
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

function getAppVersion(): string {
  if (memoizedAppVersion === null) {
    memoizedAppVersion = readAppVersion();
  }
  return memoizedAppVersion;
}

type ParsedSemver = {
  core: number[];
  /** null = 正式版（无 prerelease） */
  prerelease: Array<string | number> | null;
};

/** 解析宽松 semver（可选 v 前缀、允许 1 / 1.2 / 1.2.3）；失败返回 null */
function parseSemver(raw: string): ParsedSemver | null {
  const trimmed = raw.trim().replace(/^v/i, "");
  if (trimmed.length === 0) return null;

  const noBuild = trimmed.split("+", 1)[0] ?? trimmed;
  const dash = noBuild.indexOf("-");
  const coreStr = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preStr = dash === -1 ? null : noBuild.slice(dash + 1);

  const parts = coreStr.split(".");
  if (parts.length === 0 || parts.some((p) => p.length === 0)) return null;
  const core: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    core.push(Number.parseInt(p, 10));
  }

  if (preStr === null) {
    return { core, prerelease: null };
  }
  if (preStr.length === 0) return null;

  const ids = preStr.split(".");
  const prerelease: Array<string | number> = [];
  for (const id of ids) {
    if (id.length === 0) return null;
    if (/^\d+$/.test(id)) {
      prerelease.push(Number.parseInt(id, 10));
    } else if (/^[0-9A-Za-z-]+$/.test(id)) {
      prerelease.push(id);
    } else {
      return null;
    }
  }
  return { core, prerelease };
}

function compareCore(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** 按 semver：正式版 > 任意预发布；预发布标识符逐段比较 */
function comparePrerelease(
  a: Array<string | number> | null,
  b: Array<string | number> | null,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i]!;
    const y = b[i]!;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      if (x < y) return -1;
      if (x > y) return 1;
      continue;
    }
    // 数字标识符 < 非数字标识符
    if (xNum) return -1;
    if (yNum) return 1;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * remote 是否比 local 新。
 * 仅当双方都能解析为 semver 时比较；任一方无法解析则返回 false（避免 `latest` 等误报更新）。
 * 同 core 时正式版 > 预发布（如 0.1.0 > 0.1.0-beta.1）。
 */
export function isRemoteNewer(local: string, remote: string): boolean {
  const a = parseSemver(local);
  const b = parseSemver(remote);
  if (a === null || b === null) return false;

  const coreCmp = compareCore(a.core, b.core);
  if (coreCmp !== 0) return coreCmp < 0;
  return comparePrerelease(a.prerelease, b.prerelease) < 0;
}

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

async function fetchLatestRelease(
  fetchImpl: FetchLike,
): Promise<{ version: string; url: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(GITHUB_LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "homepage-version-check",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
    };
    const tag =
      typeof body.tag_name === "string" ? body.tag_name.trim() : "";
    if (tag.length === 0) {
      return null;
    }
    const url =
      typeof body.html_url === "string" && body.html_url.trim().length > 0
        ? body.html_url.trim()
        : `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
    return { version: tag, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getValidCache(now: number): CachedCheck | null {
  if (cachedCheck !== null && cachedCheck.expiresAt > now) {
    return cachedCheck;
  }
  return null;
}

async function resolveRemoteCheck(
  fetchImpl: FetchLike,
  now: number,
  bypassCache: boolean,
): Promise<CachedCheck> {
  if (!bypassCache) {
    const hit = getValidCache(now);
    if (hit) return hit;
    if (inflightCheck) return inflightCheck;
  }

  const run = (async (): Promise<CachedCheck> => {
    const remote = await fetchLatestRelease(fetchImpl);
    const entry: CachedCheck = remote
      ? {
          expiresAt: now + SUCCESS_CACHE_TTL_MS,
          latestVersion: remote.version,
          releaseUrl: remote.url,
          checkError: false,
        }
      : {
          expiresAt: now + ERROR_CACHE_TTL_MS,
          latestVersion: undefined,
          releaseUrl: undefined,
          checkError: true,
        };
    cachedCheck = entry;
    return entry;
  })();

  if (!bypassCache) {
    // 必须先挂上同一 Promise 引用，finally 才能正确清掉 inflight
    inflightCheck = run;
    void run.finally(() => {
      if (inflightCheck === run) {
        inflightCheck = null;
      }
    });
    return run;
  }
  return run;
}

function assembleResponse(
  version: string,
  remote: CachedCheck | null,
): VersionSuccessResponse {
  const latestVersion = remote?.latestVersion;
  const releaseUrl = remote?.releaseUrl;
  const checkError = remote?.checkError === true;
  const updateAvailable =
    latestVersion !== undefined && isRemoteNewer(version, latestVersion);

  const result: VersionSuccessResponse = {
    ok: true,
    version,
    updateAvailable,
  };
  if (latestVersion !== undefined) {
    result.latestVersion = latestVersion;
  }
  if (releaseUrl !== undefined) {
    result.releaseUrl = releaseUrl;
  }
  if (checkError) {
    result.checkError = true;
  }
  return result;
}

export type BuildVersionResponseOptions = {
  version?: string;
  fetchImpl?: FetchLike;
  /**
   * true：必要时出网检查更新（默认）。
   * false：仅返回本地版本；若内存中已有未过期远端缓存则一并带上，绝不发起新请求。
   */
  checkRemote?: boolean;
  /** 测试用：跳过缓存 */
  bypassCache?: boolean;
  now?: number;
};

export async function buildVersionResponse(
  options: BuildVersionResponseOptions = {},
): Promise<VersionSuccessResponse> {
  const version = options.version ?? getAppVersion();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now();
  const checkRemote = options.checkRemote !== false;
  const bypassCache = options.bypassCache === true;

  if (!checkRemote) {
    const hit = bypassCache ? null : getValidCache(now);
    return assembleResponse(version, hit);
  }

  const remote = await resolveRemoteCheck(fetchImpl, now, bypassCache);
  return assembleResponse(version, remote);
}

/** 测试辅助：清空内存缓存与版本 memo */
export function resetVersionCheckCache(): void {
  cachedCheck = null;
  inflightCheck = null;
  memoizedAppVersion = null;
}
