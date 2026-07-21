import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";

import {
  DEFAULT_DASHBOARD_TITLE,
  type NormalizedConfig,
} from "@homepage/domain";

import { ConfigEditorShell } from "@/components/config-editor";
import {
  ErrorStatus,
  LoadingStatus,
  SectionErrorBoundary,
} from "@/components/error";
import {
  Background,
  BookmarkSections,
  DASHBOARD_SHELL_CLASS,
  Header,
  InfoSection,
  ServiceSections,
} from "@/components/layout";
import { SearchDialog } from "@/components/search";
import {
  fetchConfig,
  isApiClientError,
} from "@/lib/api";
import {
  DEFAULT_APPLE_TOUCH_ICON,
  DEFAULT_BRAND_FAVICON,
  resolveBrandFavicon,
} from "@/lib/asset-path";
import { resolveDocumentTitle } from "@/lib/config-editor/validation";
import {
  DockerStatusProvider,
  useOptionalDockerStatusStore,
} from "@/lib/docker-status-store";
import {
  formatPublicError,
  formatUnknownError,
} from "@/lib/format-error";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

const FAVICON_LINK_ATTR = "data-homepage-favicon";

function applyDocumentFavicon(src: string | undefined): void {
  if (typeof document === "undefined") return;
  const existing = document.head.querySelectorAll(`link[${FAVICON_LINK_ATTR}]`);
  for (const node of existing) {
    node.remove();
  }
  const href = resolveBrandFavicon(src);
  const link = document.createElement("link");
  link.setAttribute(FAVICON_LINK_ATTR, "true");
  link.rel = "icon";
  if (href.endsWith(".svg")) {
    link.type = "image/svg+xml";
  } else if (href.endsWith(".png")) {
    link.type = "image/png";
  } else if (href.endsWith(".ico")) {
    link.type = "image/x-icon";
  }
  link.href = href;
  document.head.appendChild(link);

  const apple = document.createElement("link");
  apple.setAttribute(FAVICON_LINK_ATTR, "true");
  apple.rel = "apple-touch-icon";
  apple.href =
    href === DEFAULT_BRAND_FAVICON || href.endsWith(".svg")
      ? DEFAULT_APPLE_TOUCH_ICON
      : href;
  document.head.appendChild(apple);
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; config: NormalizedConfig };

function resolveConfigErrorMessage(error: unknown): string {
  if (isApiClientError(error)) {
    if (error.publicError) {
      return formatPublicError(
        error.publicError,
        messages.config.errorFallback,
      );
    }
    const msg = error.message?.trim();
    return msg && msg.length > 0 ? msg : messages.config.errorFallback;
  }
  return formatUnknownError(error, messages.config.errorFallback);
}

function ConfigEditorWithDockerPause({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void | Promise<void>;
}): JSX.Element {
  const store = useOptionalDockerStatusStore();

  useEffect(() => {
    store?.setPaused(open);
    return () => {
      store?.setPaused(false);
    };
  }, [open, store]);

  return (
    <ConfigEditorShell
      open={open}
      onOpenChange={onOpenChange}
      {...(onSaved !== undefined ? { onSaved } : {})}
    />
  );
}

export function DashboardPage(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const searchTriggerRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const config = await fetchConfig({ signal });
      if (signal.aborted) {
        return;
      }
      setState({ status: "success", config });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        return;
      }
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      setState({
        status: "error",
        message: resolveConfigErrorMessage(error),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    void load(controller.signal);
    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [load, reloadToken]);

  useEffect(() => {
    if (state.status !== "success") {
      return;
    }
    document.title = resolveDocumentTitle(state.config.settings.title);
    applyDocumentFavicon(state.config.settings.favicon);
  }, [state]);

  const handleRetry = useCallback(() => {
    abortRef.current?.abort();
    setReloadToken((n) => n + 1);
  }, []);

  const openSearch = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      searchTriggerRef.current = active;
    }
    setSearchOpen(true);
  }, []);

  const handleSearchOpenChange = useCallback((next: boolean) => {
    setSearchOpen(next);
    if (!next) {
      const trigger = searchTriggerRef.current;
      if (trigger) {
        window.setTimeout(() => {
          trigger.focus();
        }, 0);
      }
    }
  }, []);

  const handleConfigSaved = useCallback(async () => {
    try {
      const config = await fetchConfig();
      setState({ status: "success", config });
      document.title = resolveDocumentTitle(config.settings.title);
      applyDocumentFavicon(config.settings.favicon);
    } catch {
      // 保存已成功；刷新失败时允许用户手动重试主视图
      setReloadToken((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }
      const isModK =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k";
      if (!isModK) {
        return;
      }
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openSearch]);

  if (state.status === "loading") {
    return (
      <div
        className="relative flex min-h-screen flex-col text-foreground"
        data-slot="dashboard-page"
        data-state="loading"
      >
        <Background />
        <div
          className={cn(
            DASHBOARD_SHELL_CLASS,
            "relative z-10 flex flex-1 flex-col justify-center py-16",
          )}
        >
          <LoadingStatus
            message={messages.config.loading}
            centered
            className="mx-auto w-full max-w-sm rounded-2xl border border-border/50 bg-card/55 px-6 py-2 shadow-sm backdrop-blur-md"
          />
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        className="relative flex min-h-screen flex-col text-foreground"
        data-slot="dashboard-page"
        data-state="error"
      >
        <Background />
        <div
          className={cn(
            DASHBOARD_SHELL_CLASS,
            "relative z-10 flex max-w-lg flex-1 flex-col justify-center py-16",
          )}
        >
          <div className="mb-3 text-center">
            <h1 className="text-lg font-semibold">
              {messages.config.errorTitle}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {messages.common.retryHint}
            </p>
          </div>
          <ErrorStatus message={state.message} onRetry={handleRetry} />
        </div>
      </div>
    );
  }

  const { config } = state;
  const { settings, services, bookmarks, infoWidgets } = config;
  const title =
    settings.title?.trim() || DEFAULT_DASHBOARD_TITLE;

  return (
    <DockerStatusProvider enabled>
      <div
        className="relative flex min-h-screen flex-col text-foreground"
        data-slot="dashboard-page"
        data-state="success"
      >
        <Background
          {...(settings.background !== undefined
            ? { src: settings.background }
            : {})}
        />

        <div className="relative z-10 flex min-h-screen flex-1 flex-col">
          <Header
            title={title}
            {...(settings.favicon !== undefined
              ? { favicon: settings.favicon }
              : {})}
            onSearchOpen={openSearch}
            onConfigOpen={() => setConfigOpen(true)}
          />

          <main
            className={cn(
              DASHBOARD_SHELL_CLASS,
              "flex flex-1 flex-col gap-8 py-5 sm:gap-9 sm:py-7",
            )}
          >
            <SectionErrorBoundary
              label={messages.layout.infoSection}
              resetKeys={[infoWidgets]}
            >
              <InfoSection widgets={infoWidgets} />
            </SectionErrorBoundary>

            <SectionErrorBoundary
              label={messages.layout.servicesSection}
              resetKeys={[services]}
            >
              <ServiceSections
                groups={services}
                layout={settings.layout}
                useEqualHeights={settings.useEqualHeights}
              />
            </SectionErrorBoundary>

            <SectionErrorBoundary
              label={messages.layout.bookmarksSection}
              resetKeys={[bookmarks]}
            >
              <BookmarkSections groups={bookmarks} />
            </SectionErrorBoundary>
          </main>
        </div>

        <SearchDialog
          open={searchOpen}
          onOpenChange={handleSearchOpenChange}
          services={services}
          bookmarks={bookmarks}
        />

        <ConfigEditorWithDockerPause
          open={configOpen}
          onOpenChange={setConfigOpen}
          onSaved={handleConfigSaved}
        />
      </div>
    </DockerStatusProvider>
  );
}
