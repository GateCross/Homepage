import {
  ApiErrorCode,
  createPublicError,
  type PublicError,
} from "@homepage/domain";

import { ConfigValidationError } from "../errors.js";

/** Docker 连接串含 URI userinfo 时的固定简体中文错误文案 */
export const DOCKER_CONNECTION_SENSITIVE_MESSAGE =
  "Docker 连接串不得包含用户名或密码等内嵌凭据，请改用环境变量或安全的服务端配置方式" as const;

export const CONFIG_FAULTED_MESSAGE =
  "配置处于故障状态，服务已暂停配置读写。请恢复磁盘上的配置五文件后重试" as const;

export const CONFIG_WRITE_IN_PROGRESS_MESSAGE =
  "配置正在保存中，请稍后再试" as const;

export const CONFIG_SAVE_FAILED_MESSAGE =
  "配置保存失败，已恢复为保存前状态。请检查后重试" as const;

export function createDockerConnectionSensitiveError(
  path?: string,
): ConfigValidationError {
  const publicError = createPublicError({
    message: DOCKER_CONNECTION_SENSITIVE_MESSAGE,
    code: ApiErrorCode.DOCKER_CONNECTION_SENSITIVE,
    file: "docker.yaml",
    ...(path !== undefined ? { path } : {}),
  });
  return new ConfigValidationError(publicError);
}

export function createConfigFaultedError(
  message: string = CONFIG_FAULTED_MESSAGE,
): ConfigValidationError {
  const publicError = createPublicError({
    message,
    code: ApiErrorCode.CONFIG_FAULTED,
  });
  return new ConfigValidationError(publicError);
}

export function createConfigWriteInProgressError(): ConfigValidationError {
  const publicError = createPublicError({
    message: CONFIG_WRITE_IN_PROGRESS_MESSAGE,
    code: ApiErrorCode.CONFIG_WRITE_IN_PROGRESS,
  });
  return new ConfigValidationError(publicError);
}

export function createFieldValidationError(
  message: string,
  location: { file?: string; path?: string },
): ConfigValidationError {
  const publicError = createPublicError({
    message,
    code: ApiErrorCode.CONFIG_INVALID,
    ...(location.file !== undefined ? { file: location.file } : {}),
    ...(location.path !== undefined ? { path: location.path } : {}),
  });
  return new ConfigValidationError(publicError);
}

export function publicErrorFromUnknown(err: unknown): PublicError {
  if (err instanceof ConfigValidationError) {
    return err.publicError;
  }
  return createPublicError({
    message: "配置处理失败",
    code: ApiErrorCode.INTERNAL,
  });
}

/**
 * 检测 Docker 连接串是否含 URI userinfo（user:pass@ 或 user@）。
 * 不解析/不回显原串内容；仅做结构性检测。
 */
export function dockerConnectionHasUserInfo(connection: string): boolean {
  const trimmed = connection.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // unix:// 无 authority userinfo
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("unix://")) {
    return false;
  }

  // tcp://[userinfo@]host:port
  if (lower.startsWith("tcp://")) {
    const rest = trimmed.slice("tcp://".length);
    return authorityHasUserInfo(rest);
  }

  // 其它 scheme://... 也做通用检测
  const schemeSep = trimmed.indexOf("://");
  if (schemeSep > 0) {
    const rest = trimmed.slice(schemeSep + 3);
    return authorityHasUserInfo(rest);
  }

  return false;
}

function authorityHasUserInfo(authority: string): boolean {
  // 取 path 之前的 authority
  const slash = authority.indexOf("/");
  const auth = slash >= 0 ? authority.slice(0, slash) : authority;
  // userinfo 以 @ 分隔；IPv6 字面量中的 @ 不会出现在 [] 外作为 userinfo 以外的用途
  // 若 @ 在 ] 之后则是异常；标准写法 userinfo 在 host 前
  const at = auth.lastIndexOf("@");
  if (at <= 0) {
    return false;
  }
  // @ 前非空即视为 userinfo
  const userinfo = auth.slice(0, at);
  return userinfo.length > 0;
}

export function isNonEmptySecretString(raw: unknown): boolean {
  return typeof raw === "string" && raw.length > 0;
}

export function secretStatusFromRaw(
  raw: unknown,
): "configured" | "unset" {
  return isNonEmptySecretString(raw) ? "configured" : "unset";
}
