import { normalizeAbsoluteHttpUrl } from "../ids/normalize.js";

export function isAbsoluteHttpUrl(value: string): boolean {
  return normalizeAbsoluteHttpUrl(value) !== null;
}
