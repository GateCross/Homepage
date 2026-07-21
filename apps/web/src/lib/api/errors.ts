import type { PublicError } from "@homepage/domain";

import { messages } from "../messages";

export type ApiClientErrorKind =
  | "network"
  | "non_json"
  | "http_error"
  | "invalid_response";

export type ApiClientErrorOptions = {
  kind: ApiClientErrorKind;
  status?: number;
  publicError?: PublicError;
  cause?: unknown;
};

export class ApiClientError extends Error {
  override readonly name = "ApiClientError";
  readonly kind: ApiClientErrorKind;
  readonly status?: number;
  readonly publicError?: PublicError;

  constructor(message: string, options: ApiClientErrorOptions) {
    if (options.cause !== undefined) {
      super(message, { cause: options.cause });
    } else {
      super(message);
    }
    this.kind = options.kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.publicError !== undefined) {
      this.publicError = options.publicError;
    }
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

export const API_CLIENT_MESSAGES = {
  network: messages.error.network,
  aborted: "请求已取消",
  nonJson: messages.error.invalidJson,
  invalidSuccess: messages.error.invalidResponse,
  httpFallback: messages.error.server,
  emptyBody: "服务器返回了空响应",
  missingId: "标识无效",
} as const;
