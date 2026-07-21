import {
  ApiErrorCode,
  createPublicError,
  type PublicError,
} from "@homepage/domain";

import type { ConfigFileName } from "./constants.js";

export class ConfigValidationError extends Error {
  readonly publicError: PublicError;

  constructor(publicError: PublicError) {
    super(publicError.message);
    this.name = "ConfigValidationError";
    this.publicError = publicError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ConfigErrorLocation = {
  file: ConfigFileName | string;
  path?: string;
  line?: number;
  column?: number;
};

export function createConfigValidationError(
  message: string,
  location: ConfigErrorLocation,
): ConfigValidationError {
  const publicError = createPublicError({
    message,
    code: ApiErrorCode.CONFIG_INVALID,
    file: location.file,
    ...(location.path !== undefined ? { path: location.path } : {}),
    ...(location.line !== undefined ? { line: location.line } : {}),
    ...(location.column !== undefined ? { column: location.column } : {}),
  });
  return new ConfigValidationError(publicError);
}

export function isConfigValidationError(
  error: unknown,
): error is ConfigValidationError {
  return error instanceof ConfigValidationError;
}
