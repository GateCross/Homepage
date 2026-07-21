import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";

import type { EditableConfigWrite } from "@homepage/domain";

import { BookmarksEditor } from "@/components/config-editor/BookmarksEditor";
import {
  DockerEndpointsEditor,
  InfoWidgetsEditor,
} from "@/components/config-editor/InfoDockerEditors";
import { ServicesEditor } from "@/components/config-editor/ServicesEditor";
import { SettingsForm } from "@/components/config-editor/SettingsForm";
import { LoadingStatus } from "@/components/error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchEditableConfig,
  isApiClientError,
  saveConfig,
} from "@/lib/api";
import {
  editableViewToDefaultWrite,
  prepareDraftForSave,
  validateEditableDraft,
  type FieldErrors,
} from "@/lib/config-editor/validation";
import { formatPublicError, formatUnknownError } from "@/lib/format-error";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

type TabKey = "settings" | "services" | "bookmarks" | "info" | "docker";

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "success" }
  | { status: "error"; message: string };

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; draft: EditableConfigWrite };

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "settings", label: "设置" },
  { key: "services", label: "服务" },
  { key: "bookmarks", label: "书签" },
  { key: "info", label: "信息" },
  { key: "docker", label: "Docker" },
];

export type ConfigEditorShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 保存成功后回调，用于刷新仪表盘配置 */
  onSaved?: () => void | Promise<void>;
};

export function ConfigEditorShell({
  open,
  onOpenChange,
  onSaved,
}: ConfigEditorShellProps): JSX.Element {
  const [tab, setTab] = useState<TabKey>("settings");
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const abortRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoadState({ status: "loading" });
    setSaveState({ status: "idle" });
    setFieldErrors({});
    try {
      const editable = await fetchEditableConfig({ signal });
      if (signal.aborted) return;
      setLoadState({
        status: "ready",
        draft: editableViewToDefaultWrite(editable),
      });
    } catch (error) {
      if (signal.aborted) return;
      if (
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return;
      }
      let message = "无法加载可编辑配置";
      if (isApiClientError(error)) {
        message = error.publicError
          ? formatPublicError(error.publicError, message)
          : error.message || message;
      } else {
        message = formatUnknownError(error, message);
      }
      setLoadState({ status: "error", message });
    }
  }, []);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [open, load]);

  const setDraft = useCallback((draft: EditableConfigWrite) => {
    setLoadState((prev) =>
      prev.status === "ready" ? { status: "ready", draft } : prev,
    );
  }, []);

  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    if (loadState.status !== "ready") return;

    const payload = prepareDraftForSave(loadState.draft);
    const errors = validateEditableDraft(payload);
    if (errors !== null) {
      setFieldErrors(errors);
      setSaveState({
        status: "error",
        message: "请修正标红字段后再保存",
      });
      return;
    }

    setFieldErrors({});
    savingRef.current = true;
    setSaveState({ status: "saving" });

    try {
      await saveConfig(payload);
      setSaveState({ status: "success" });
      if (onSaved) {
        await onSaved();
      }
    } catch (error) {
      let message = "保存失败，请稍后重试";
      if (isApiClientError(error)) {
        message = error.publicError
          ? formatPublicError(error.publicError, message)
          : error.message || message;
      } else if (
        !(error instanceof DOMException && error.name === "AbortError") &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        message = formatUnknownError(error, message);
      } else {
        savingRef.current = false;
        setSaveState({ status: "idle" });
        return;
      }
      setSaveState({ status: "error", message });
    } finally {
      savingRef.current = false;
    }
  }, [loadState, onSaved]);

  const saving = saveState.status === "saving";
  const draft = loadState.status === "ready" ? loadState.draft : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={!saving}
        className="flex max-h-[90vh] w-[min(56rem,calc(100vw-2rem))] max-w-4xl flex-col gap-0 overflow-hidden p-0"
        onPointerDownOutside={(e) => {
          if (saving) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (saving) e.preventDefault();
        }}
      >
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle>配置</DialogTitle>
          <DialogDescription>
            通过结构化表单编辑仪表盘配置，保存后立即生效。不提供 YAML 源码编辑。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <nav
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-4 py-2"
            aria-label="配置分类"
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={loadState.status !== "ready" || saving}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  tab === t.key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {loadState.status === "loading" ? (
              <div
                data-slot="config-editor-loading"
                className="space-y-5"
                aria-busy="true"
              >
                <LoadingStatus
                  message={messages.config.loading}
                  centered
                  className="py-4"
                />
                <div className="space-y-5" aria-hidden="true">
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-12" />
                    <Skeleton className="h-9 w-full rounded-md" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-16" />
                    <Skeleton className="h-24 w-full rounded-md" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-20" />
                    <Skeleton className="h-9 w-full rounded-md" />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-2">
                      <Skeleton className="h-3.5 w-24" />
                      <Skeleton className="h-3 w-40" />
                    </div>
                    <Skeleton className="h-6 w-10 rounded-full" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-3.5 w-14" />
                    <Skeleton className="h-9 w-full rounded-md" />
                  </div>
                </div>
              </div>
            ) : null}
            {loadState.status === "error" ? (
              <div className="space-y-3">
                <p className="text-sm text-destructive">{loadState.message}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const controller = new AbortController();
                    abortRef.current = controller;
                    void load(controller.signal);
                  }}
                >
                  重试
                </Button>
              </div>
            ) : null}
            {draft ? (
              <>
                {tab === "settings" ? (
                  <SettingsForm
                    value={draft.settings}
                    disabled={saving}
                    errors={fieldErrors}
                    onChange={(settings) => setDraft({ ...draft, settings })}
                  />
                ) : null}
                {tab === "services" ? (
                  <ServicesEditor
                    value={draft.services}
                    dockerEndpoints={draft.dockerEndpoints}
                    disabled={saving}
                    errors={fieldErrors}
                    onChange={(services) => setDraft({ ...draft, services })}
                  />
                ) : null}
                {tab === "bookmarks" ? (
                  <BookmarksEditor
                    value={draft.bookmarks}
                    disabled={saving}
                    errors={fieldErrors}
                    onChange={(bookmarks) => setDraft({ ...draft, bookmarks })}
                  />
                ) : null}
                {tab === "info" ? (
                  <InfoWidgetsEditor
                    value={draft.infoWidgets}
                    disabled={saving}
                    errors={fieldErrors}
                    onChange={(infoWidgets) =>
                      setDraft({ ...draft, infoWidgets })
                    }
                  />
                ) : null}
                {tab === "docker" ? (
                  <DockerEndpointsEditor
                    value={draft.dockerEndpoints}
                    disabled={saving}
                    errors={fieldErrors}
                    onChange={(dockerEndpoints) =>
                      setDraft({ ...draft, dockerEndpoints })
                    }
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-6 py-4 sm:justify-between">
          <div className="min-h-5 flex-1 text-sm">
            {saveState.status === "error" ? (
              <span className="text-destructive">{saveState.message}</span>
            ) : null}
            {saveState.status === "success" ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                保存成功
              </span>
            ) : null}
            {saveState.status === "saving" ? (
              <span className="text-muted-foreground">正在保存…</span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
            <Button
              type="button"
              disabled={saving || loadState.status !== "ready"}
              onClick={() => void handleSave()}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
