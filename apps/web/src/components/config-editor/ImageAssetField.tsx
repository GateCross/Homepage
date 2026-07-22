import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from "react";
import { Globe, ImagePlus, Trash2 } from "lucide-react";

import type { IconCandidate } from "@homepage/domain";

import { SiteIconPickerDialog } from "@/components/config-editor/SiteIconPickerDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  importSiteIcon,
  isApiClientError,
  resolveSiteIcons,
  uploadAsset,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export type ImageAssetFieldProps = {
  id?: string;
  label: string;
  value: string;
  /** 空串表示清除；勿用 undefined（merge 会保留磁盘原值） */
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  /** 预览样式：背景铺满 / 图标缩略 */
  preview?: "background" | "icon";
  className?: string;
  /**
   * 从站点获取图标的源地址（条目 href）。
   * 传入有效 http(s) 时显示「从站点获取」；
   * 未传或为空则不显示该入口（如背景图字段、无 href 的服务）。
   */
  siteIconSourceUrl?: string | null | undefined;
};

function isPreviewablePath(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (v.startsWith("http://") || v.startsWith("https://")) return true;
  if (!v.startsWith("/") || v.startsWith("//")) return false;
  if (v.includes("..") || v.includes("\\")) return false;
  return true;
}

function isUsableHttpUrl(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const v = raw.trim();
  if (v.length === 0) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function ImageAssetField({
  id: idProp,
  label,
  value,
  onChange,
  disabled,
  placeholder = "可选，绝对 http(s) 或 /images/... 路径",
  hint,
  preview = "icon",
  className,
  siteIconSourceUrl,
}: ImageAssetFieldProps): JSX.Element {
  const autoId = useId();
  const id = idProp ?? autoId;
  const fileInputId = `${id}-file`;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<IconCandidate[]>([]);
  const [resolvedSource, setResolvedSource] = useState("");

  const trimmed = value.trim();
  const showPreview = isPreviewablePath(trimmed) && !previewFailed;
  const canFetchSiteIcon =
    preview === "icon" && isUsableHttpUrl(siteIconSourceUrl);
  const busy = Boolean(disabled) || uploading || resolving || importing;

  const handleTextChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setError(null);
    setPreviewFailed(false);
    const v = e.target.value;
    // 空串表示清除；undefined 会在 merge 时保留磁盘原值
    onChange(v.trim().length === 0 ? "" : v);
  };

  const handlePickClick = (): void => {
    setError(null);
    fileRef.current?.click();
  };

  const handleFileChange = async (
    e: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    // 允许重复选择同一文件
    e.target.value = "";
    if (!file) return;

    setUploading(true);
    setError(null);
    setPreviewFailed(false);
    try {
      const result = await uploadAsset(file);
      onChange(result.path);
    } catch (err) {
      const message = isApiClientError(err)
        ? err.message
        : "上传失败，请稍后重试";
      setError(message);
    } finally {
      setUploading(false);
    }
  };

  const closePicker = (): void => {
    if (importing) return;
    setPickerOpen(false);
    setPickerError(null);
    setCandidates([]);
    setSessionId(null);
  };

  const startFetchSiteIcon = async (): Promise<void> => {
    const source = (siteIconSourceUrl ?? "").trim();
    if (!isUsableHttpUrl(source)) {
      setError("请先填写有效的 http(s) 链接");
      return;
    }

    setResolving(true);
    setError(null);
    setPickerError(null);
    try {
      const result = await resolveSiteIcons(source);
      setSessionId(result.sessionId);
      setCandidates(result.candidates);
      setResolvedSource(result.sourceUrl);
      setPickerOpen(true);
    } catch (err) {
      const message = isApiClientError(err)
        ? err.message
        : "获取站点图标失败，请稍后重试";
      setError(message);
    } finally {
      setResolving(false);
    }
  };

  const handleFetchSiteIcon = (): void => {
    const source = (siteIconSourceUrl ?? "").trim();
    if (!isUsableHttpUrl(source)) {
      setError("请先填写有效的 http(s) 链接");
      return;
    }

    // 已有 icon 时先弹应用内确认，再发起获取
    if (trimmed.length > 0) {
      setError(null);
      setOverwriteConfirmOpen(true);
      return;
    }

    void startFetchSiteIcon();
  };

  const handleImportCandidate = async (candidateId: string): Promise<void> => {
    if (!sessionId) {
      setPickerError("会话已失效，请重新获取");
      return;
    }
    setImporting(true);
    setPickerError(null);
    try {
      const result = await importSiteIcon({ sessionId, candidateId });
      onChange(result.path);
      setPreviewFailed(false);
      setError(null);
      setPickerOpen(false);
      setCandidates([]);
      setSessionId(null);
    } catch (err) {
      const message = isApiClientError(err)
        ? err.message
        : "导入图标失败，请重新获取";
      setPickerError(message);
    } finally {
      setImporting(false);
    }
  };

  const defaultHint = canFetchSiteIcon
    ? "可粘贴 URL、上传本地图片，或从条目链接获取站点图标（保存配置后生效）"
    : "可粘贴 URL，或从本机选择图片上传到站点（保存配置后生效）";

  return (
    <div className={cn("space-y-1.5", className)} data-slot="image-asset-field">
      <Label htmlFor={id}>{label}</Label>
      <div
        className={cn(
          "flex gap-3",
          preview === "background" ? "flex-col" : "items-start",
        )}
      >
        {preview === "icon" ? (
          <div
            className={cn(
              "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40",
              !showPreview && "border-dashed text-muted-foreground/50",
            )}
          >
            {showPreview ? (
              <img
                src={trimmed}
                alt=""
                className="h-full w-full object-contain p-1"
                onError={() => setPreviewFailed(true)}
              />
            ) : (
              <ImagePlus className="size-5" aria-hidden="true" />
            )}
          </div>
        ) : null}

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={id}
              value={value}
              disabled={busy}
              placeholder={placeholder}
              onChange={handleTextChange}
              className="min-w-0 flex-1 basis-[12rem]"
            />
            <input
              ref={fileRef}
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/x-icon,.jpg,.jpeg,.png,.webp,.gif,.svg,.ico"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                void handleFileChange(e);
              }}
            />
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={handlePickClick}
                    className="gap-1.5"
                  >
                    <ImagePlus className="size-3.5" aria-hidden="true" />
                    {uploading ? "上传中…" : "上传"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>选择本地图片上传</TooltipContent>
              </Tooltip>
              {canFetchSiteIcon ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={handleFetchSiteIcon}
                      className="gap-1.5"
                    >
                      <Globe className="size-3.5" aria-hidden="true" />
                      {resolving ? "获取中…" : "站点"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>根据条目链接解析站点图标</TooltipContent>
                </Tooltip>
              ) : null}
              {trimmed.length > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label="清除图标"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        setError(null);
                        setPreviewFailed(false);
                        onChange("");
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>清除</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
          {hint ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{defaultHint}</p>
          )}
          {!canFetchSiteIcon &&
          preview === "icon" &&
          siteIconSourceUrl !== undefined ? (
            <p className="text-xs text-muted-foreground">
              无有效链接时无法从站点获取，请上传或手填。
            </p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </div>

      {preview === "background" && showPreview ? (
        <div className="h-28 w-full overflow-hidden rounded-md border border-border/60 bg-muted/40">
          <img
            src={trimmed}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setPreviewFailed(true)}
          />
        </div>
      ) : null}

      <Dialog
        open={overwriteConfirmOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setOverwriteConfirmOpen(open);
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>覆盖现有图标？</DialogTitle>
            <DialogDescription>
              当前表单已有图标。继续获取并采用新图标会覆盖该字段；已上传的旧本地文件不会自动删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOverwriteConfirmOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setOverwriteConfirmOpen(false);
                void startFetchSiteIcon();
              }}
            >
              继续获取
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SiteIconPickerDialog
        open={pickerOpen}
        onOpenChange={(open) => {
          if (!open) closePicker();
          else setPickerOpen(true);
        }}
        sourceUrl={resolvedSource}
        candidates={candidates}
        importing={importing}
        error={pickerError}
        onConfirm={(candidateId) => {
          void handleImportCandidate(candidateId);
        }}
      />
    </div>
  );
}
