import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  Bookmark,
  Container,
  Gauge,
  Server,
  Settings2,
  type LucideIcon,
} from "lucide-react";

import type { EditableConfigWrite } from "@/lib/contracts";

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
  isAbortError,
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

const TABS: Array<{ key: TabKey; label: string; Icon: LucideIcon }> = [
  { key: "settings", label: "设置", Icon: Settings2 },
  { key: "services", label: "服务", Icon: Server },
  { key: "bookmarks", label: "书签", Icon: Bookmark },
  { key: "info", label: "信息", Icon: Gauge },
  { key: "docker", label: "Docker", Icon: Container },
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
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  /** 载入成功时的草稿指纹，用于判断「有未保存的修改」 */
  const baselineRef = useRef<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoadState({ status: "loading" });
    setSaveState({ status: "idle" });
    setFieldErrors({});
    try {
      const editable = await fetchEditableConfig({ signal });
      if (signal.aborted) return;
      const draft = editableViewToDefaultWrite(editable);
      baselineRef.current = JSON.stringify(draft);
      setLoadState({ status: "ready", draft });
    } catch (error) {
      if (signal.aborted) return;
      baselineRef.current = null;
      if (isAbortError(error)) {
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

  const setDraft = useCallback(
    (
      next:
        | EditableConfigWrite
        | ((prev: EditableConfigWrite) => EditableConfigWrite),
    ) => {
      setLoadState((prev) => {
        if (prev.status !== "ready") return prev;
        const draft = typeof next === "function" ? next(prev.draft) : next;
        return { status: "ready", draft };
      });
    },
    [],
  );

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
      // 保存成功并刷新仪表盘后关闭编辑器，直接回到服务列表
      onOpenChange(false);
    } catch (error) {
      // saveConfig 未传 signal 超时转为 ApiClientError，onSaved 自吞错误，
      // 此处不会收到裸 AbortError
      let message = "保存失败，请稍后重试";
      if (isApiClientError(error)) {
        message = error.publicError
          ? formatPublicError(error.publicError, message)
          : error.message || message;
      } else {
        message = formatUnknownError(error, message);
      }
      setSaveState({ status: "error", message });
    } finally {
      savingRef.current = false;
    }
  }, [loadState, onSaved, onOpenChange]);

  const saving = saveState.status === "saving";
  const draft = loadState.status === "ready" ? loadState.draft : null;
  const dirty =
    loadState.status === "ready" &&
    baselineRef.current !== null &&
    JSON.stringify(loadState.draft) !== baselineRef.current;

  /**
   * 统一关闭入口：Escape / 点遮罩 / 右下角「关闭」都汇到这里。
   * 保存中不允许关闭；有未保存修改时先弹确认，避免静默丢失。
   */
  const requestClose = useCallback((): void => {
    if (savingRef.current) return;
    if (dirty) {
      setConfirmCloseOpen(true);
      return;
    }
    onOpenChange(false);
  }, [dirty, onOpenChange]);

  const handleRootOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        onOpenChange(true);
        return;
      }
      requestClose();
    },
    [requestClose],
  );

  return (
    <Dialog open={open} onOpenChange={handleRootOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[100dvh] w-[100vw] max-w-[100vw] flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] sm:rounded-2xl"
        onPointerDownOutside={(e) => {
          if (saving) e.preventDefault();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex shrink-0 flex-col border-b border-border/60 md:w-48 md:border-b-0 md:border-r">
            <div className="px-4 pb-2 pt-4 md:pb-3 md:pt-5">
              <DialogTitle className="text-base">配置</DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-relaxed">
                通过结构化表单编辑仪表盘配置，保存后立即生效。
              </DialogDescription>
            </div>
            <nav
              className="flex shrink-0 gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0.5 md:overflow-visible md:px-3 md:pb-3"
              aria-label="配置分类"
            >
              {TABS.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  disabled={loadState.status !== "ready" || saving}
                  aria-current={tab === key ? "page" : undefined}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-full",
                    tab === key
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground",
                  )}
                  onClick={() => setTab(key)}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="w-full px-4 py-5 sm:px-6 sm:py-6">
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
                    <p className="text-sm text-destructive">
                      {loadState.message}
                    </p>
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
                        onChange={(settings) =>
                          setDraft((prev) => ({ ...prev, settings }))
                        }
                      />
                    ) : null}
                    {tab === "services" ? (
                      <ServicesEditor
                        value={draft.services}
                        dockerEndpoints={draft.dockerEndpoints}
                        disabled={saving}
                        errors={fieldErrors}
                        onChange={(services) =>
                          setDraft((prev) => ({ ...prev, services }))
                        }
                      />
                    ) : null}
                    {tab === "bookmarks" ? (
                      <BookmarksEditor
                        value={draft.bookmarks}
                        disabled={saving}
                        errors={fieldErrors}
                        onChange={(bookmarks) =>
                          setDraft((prev) => ({ ...prev, bookmarks }))
                        }
                      />
                    ) : null}
                    {tab === "info" ? (
                      <InfoWidgetsEditor
                        value={draft.infoWidgets}
                        disabled={saving}
                        errors={fieldErrors}
                        onChange={(infoWidgets) =>
                          setDraft((prev) => ({ ...prev, infoWidgets }))
                        }
                      />
                    ) : null}
                    {tab === "docker" ? (
                      <DockerEndpointsEditor
                        value={draft.dockerEndpoints}
                        disabled={saving}
                        errors={fieldErrors}
                        onChange={(dockerEndpoints) =>
                          setDraft((prev) => ({ ...prev, dockerEndpoints }))
                        }
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>

            <div className="shrink-0 border-t border-border/60 bg-card/30 px-4 py-3 sm:px-6">
              <div className="flex w-full items-center justify-between gap-4">
                <div className="min-h-5 min-w-0 flex-1 text-sm">
                  {saveState.status === "error" ? (
                    <span className="text-destructive">
                      {saveState.message}
                    </span>
                  ) : null}
                  {saveState.status === "success" ? (
                    <span className="text-status-online">保存成功</span>
                  ) : null}
                  {saveState.status === "saving" ? (
                    <span className="text-muted-foreground">正在保存…</span>
                  ) : null}
                  {saveState.status === "idle" && dirty ? (
                    <span className="text-muted-foreground">
                      有未保存的修改
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={requestClose}
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
              </div>
            </div>
          </div>
        </div>

        <Dialog
          open={confirmCloseOpen}
          onOpenChange={(next) => {
            if (saving) return;
            setConfirmCloseOpen(next);
          }}
        >
          <DialogContent className="max-w-md" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>放弃未保存的修改？</DialogTitle>
              <DialogDescription>
                关闭编辑器后，本次尚未保存的修改将丢失。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setConfirmCloseOpen(false)}
              >
                继续编辑
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={saving}
                onClick={() => {
                  setConfirmCloseOpen(false);
                  onOpenChange(false);
                }}
              >
                放弃修改
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
