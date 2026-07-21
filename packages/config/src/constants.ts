export const CONFIG_FILE_NAMES = [
  "settings.yaml",
  "services.yaml",
  "bookmarks.yaml",
  "widgets.yaml",
  "docker.yaml",
] as const;

export type ConfigFileName = (typeof CONFIG_FILE_NAMES)[number];

export const CONFIG_DIR_ENV = "CONFIG_DIR" as const;

export const DEFAULT_CONFIG_DIR_NAME = "config" as const;
