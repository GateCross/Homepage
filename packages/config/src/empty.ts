import {
  DEFAULT_DASHBOARD_TITLE,
  NormalizedConfigSchema,
  type NormalizedConfig,
  type NormalizedSettings,
} from "@homepage/domain";

import { createEmptyAllowList, type AllowList } from "./allowlist.js";

export function createDefaultSettings(): NormalizedSettings {
  return {
    title: DEFAULT_DASHBOARD_TITLE,
    useEqualHeights: false,
    layout: {},
  };
}

export function createEmptyNormalizedConfig(): NormalizedConfig {
  return NormalizedConfigSchema.parse({
    settings: createDefaultSettings(),
    services: [],
    bookmarks: [],
    infoWidgets: [],
  });
}

export function createEmptyLoadResult(): {
  config: NormalizedConfig;
  allowList: AllowList;
} {
  return {
    config: createEmptyNormalizedConfig(),
    allowList: createEmptyAllowList(),
  };
}
