import type { PublicError } from "@/lib/contracts";

import { isApiClientError } from "./api/errors";
import { messages } from "./messages";

/**
 * 把任意错误收敛成一句可展示的中文。带 publicError 时优先用它拼出定位信息，
 * fallback 是该场景的固定兜底文案。
 */
export function resolveErrorMessage(error: unknown, fallback: string): string {
  if (isApiClientError(error)) {
    if (error.publicError) {
      return formatPublicError(error.publicError, fallback);
    }
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : fallback;
  }
  return formatUnknownError(error, fallback);
}

export function formatPublicError(
  error: PublicError | null | undefined,
  fallback: string = messages.common.unknownError,
): string {
  if (!error) {
    return fallback;
  }

  const parts: string[] = [];
  const message = error.message?.trim();
  parts.push(message && message.length > 0 ? message : fallback);

  const location: string[] = [];
  if (error.file) {
    location.push(error.file);
  }
  if (error.path) {
    location.push(error.path);
  }
  if (error.line !== undefined) {
    const col =
      error.column !== undefined ? `第 ${error.line} 行第 ${error.column} 列` : `第 ${error.line} 行`;
    location.push(col);
  } else if (error.column !== undefined) {
    location.push(`第 ${error.column} 列`);
  }

  if (location.length > 0) {
    parts.push(`（${location.join(" · ")}）`);
  }

  return parts.join("");
}

export function formatUnknownError(
  error: unknown,
  fallback: string = messages.common.unknownError,
): string {
  if (error == null) {
    return fallback;
  }

  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (error instanceof Error) {
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : fallback;
  }

  if (typeof error === "object" && "message" in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim().length > 0) {
      return msg.trim();
    }
  }

  return fallback;
}
