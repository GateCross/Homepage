import { DOMAIN_PACKAGE_NAME } from "@homepage/domain";

export const CONFIG_PACKAGE_NAME = "@homepage/config" as const;

export const CONFIG_BOUNDARY = {
  packageName: CONFIG_PACKAGE_NAME,
  dependsOn: [DOMAIN_PACKAGE_NAME] as const,
  role: "yaml-load-normalize-allowlist",
} as const;

export { DOMAIN_PACKAGE_NAME };

export {
  CONFIG_DIR_ENV,
  CONFIG_FILE_NAMES,
  DEFAULT_CONFIG_DIR_NAME,
  type ConfigFileName,
} from "./constants.js";

export {
  createEmptyAllowList,
  type AllowList,
  type DockerEndpoint,
  type HttpProbeTarget,
  type InfoTarget,
  type ResolvedSecrets,
  type WidgetTarget,
} from "./allowlist.js";

export {
  ConfigValidationError,
  createConfigValidationError,
  isConfigValidationError,
  type ConfigErrorLocation,
} from "./errors.js";

export {
  createDefaultSettings,
  createEmptyLoadResult,
  createEmptyNormalizedConfig,
} from "./empty.js";

export {
  areAllConfigFilesMissing,
  readAllConfigFiles,
  readConfigFile,
  resolveConfigDir,
  type ConfigFileReadResult,
  type FiveConfigFiles,
} from "./read-files.js";

export {
  assertTopLevelStructure,
  parseYamlFileContent,
  unreadableFileToValidationError,
  yamlSyntaxErrorToValidationError,
  type ParsedYamlDocument,
} from "./parse-yaml.js";

export {
  loadConfig,
  readAndParseConfigSources,
  type LoadConfigOptions,
  type LoadConfigResult,
  type ParsedConfigSources,
} from "./load-config.js";

export {
  assertSafeNormalizedConfig,
  collectSensitiveValues,
  publicJsonContainsSecret,
} from "./assert-safe-config.js";

export { normalizeSettings } from "./normalize-settings.js";

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  normalizeProbeTimeoutMs,
  normalizeServiceItem,
  normalizeServices,
  resolveProbeTargetUrl,
  type NormalizeServiceContext,
} from "./normalize-services.js";

export {
  dockerContainerKey,
  normalizeDockerEndpointName,
  parseDockerEndpointUrl,
  registerDockerEndpoints,
  tryRegisterServiceDocker,
} from "./normalize-docker.js";

export {
  SUPPORTED_SERVICE_WIDGET_TYPES,
  findFirstSupportedWidget,
  normalizeCustomApiMethod,
  normalizeServiceWidget,
  pickEffectiveWidgetDeclarations,
  resolveSecretString,
  type NormalizeWidgetContext,
  type NormalizeWidgetEnv,
} from "./normalize-widget.js";

export {
  DATETIME_STYLE_VALUES,
  DEFAULT_INFO_TIMEZONE,
  SUPPORTED_INFO_WIDGET_TYPES,
  collectResourceDiskEntries,
  collectResourceDiskPaths,
  expandInfoWidgetEntry,
  extractInfoWidgetEntries,
  isValidIanaTimeZone,
  normalizeDatetimeFormat,
  normalizeIanaTimeZone,
  normalizeInfoWidgetEntry,
  normalizeInfoWidgets,
  type DatetimeInfoOptions,
  type DatetimeStyle,
  type NormalizeInfoContext,
  type OpenMeteoInfoTargetOptions,
  type ResourceDiskEntry,
  type ResourcesInfoTargetOptions,
} from "./normalize-info.js";

export {
  buildBookmarkId,
  normalizeBookmarkItem,
  normalizeBookmarks,
} from "./normalize-bookmarks.js";

export {
  CONFIG_FAULTED_MESSAGE,
  CONFIG_SAVE_FAILED_MESSAGE,
  CONFIG_WRITE_IN_PROGRESS_MESSAGE,
  DOCKER_CONNECTION_SENSITIVE_MESSAGE,
  buildEditableConfig,
  cleanupPrepared,
  configFaultGate,
  configWriteLock,
  createConfigFaultedError,
  createConfigWriteInProgressError,
  createDockerConnectionSensitiveError,
  createFieldValidationError,
  dockerConnectionHasUserInfo,
  editableToFiveYamlDocuments,
  getEditableConfig,
  mergeEditableIntoSources,
  parseEditableConfigWrite,
  prepareAndValidateFiveFiles,
  replaceFiveFiles,
  rollbackReplacedFiles,
  secretStatusFromRaw,
  snapshotFiveFiles,
  writeConfig,
  type FiveFileSnapshot,
  type PreparedFiveFiles,
  type ReplaceResult,
  type WriteConfigOptions,
  type WriteConfigResult,
} from "./editable/index.js";
