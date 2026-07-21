/** 前端应用导出入口。 依赖方向：仅依赖 @homepage/domain 共享契约；通过 HTTP 消费服务端 API。 禁止：直接调用外部服务、Docker、读取服务端密钥或依赖 config/adapters 实现细节。 */
import { DOMAIN_PACKAGE_NAME } from "@homepage/domain";

export const WEB_PACKAGE_NAME = "@homepage/web" as const;

export const WEB_BOUNDARY = {
  packageName: WEB_PACKAGE_NAME,
  dependsOn: [DOMAIN_PACKAGE_NAME] as const,
  consumesServerViaHttp: true,
  allowsDirectExternalServiceCalls: false,
  role: "spa-ui-and-api-client",
} as const;

export { DOMAIN_PACKAGE_NAME };

export {
  EmptyStatus,
  ErrorBoundary,
  ErrorFallback,
  ErrorStatus,
  LoadingStatus,
  SectionErrorBoundary,
  UnsupportedStatus,
  type EmptyStatusProps,
  type ErrorBoundaryProps,
  type ErrorFallbackProps,
  type ErrorFallbackVariant,
  type ErrorStatusProps,
  type LoadingStatusProps,
  type SectionErrorBoundaryProps,
  type UnsupportedStatusProps,
} from "./components/error";

export {
  THEME_STORAGE_KEY,
  ThemeProvider,
  ThemeToggle,
  applyResolvedTheme,
  readStoredThemeMode,
  resolveThemeMode,
  themeModeLabel,
  useTheme,
  type ThemeContextValue,
  type ThemeProviderProps,
  type ThemeToggleProps,
} from "./components/theme";

export {
  API_CLIENT_MESSAGES,
  ApiClientError,
  fetchConfig,
  fetchDocker,
  fetchDockerBatch,
  fetchInfo,
  fetchProbe,
  fetchWidget,
  isApiClientError,
  type ApiClientErrorKind,
  type ApiClientErrorOptions,
  type ApiRequestOptions,
} from "./lib/api";

export {
  formatPublicError,
  formatUnknownError,
} from "./lib/format-error";

export {
  resolveBookmarkIconDisplay,
  resolveIconIdentifier,
  resolveServiceIconDisplay,
  type BookmarkIconDisplay,
  type IconResolveFailure,
  type IconResolveResult,
  type ResolvedIcon,
  type ServiceIconDisplay,
} from "./lib/icons";

export {
  dockerStatusText,
  messages,
  probeStatusText,
  probeUnreachableReasonText,
  type Messages,
  type ProbeUnreachableReasonKey,
} from "./lib/messages";

export { cn } from "./lib/utils";
