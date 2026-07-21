import { useEffect, useState, type JSX } from "react";

import type { IconCandidate } from "@homepage/domain";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const TIER_LABEL: Record<IconCandidate["tier"], string> = {
  "apple-touch-icon": "Apple Touch",
  "rel-icon": "页面图标",
  "static-apple-touch": "默认 Apple Touch",
  "static-favicon": "默认 Favicon",
};

export type SiteIconPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceUrl: string;
  candidates: IconCandidate[];
  importing?: boolean;
  error?: string | null;
  onConfirm: (candidateId: string) => void;
};

export function SiteIconPickerDialog({
  open,
  onOpenChange,
  sourceUrl,
  candidates,
  importing = false,
  error = null,
  onConfirm,
}: SiteIconPickerDialogProps): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      return;
    }
    const first = candidates[0]?.candidateId ?? null;
    setSelected((prev) => {
      if (prev !== null && candidates.some((c) => c.candidateId === prev)) {
        return prev;
      }
      return first;
    });
  }, [open, candidates]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (importing) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[85vh] max-w-xl overflow-y-auto"
        showCloseButton={!importing}
      >
        <DialogHeader>
          <DialogTitle>选择站点图标</DialogTitle>
          <DialogDescription className="break-all">
            来源：{sourceUrl}
            <span className="mt-1 block text-muted-foreground">
              采用后写入表单，需保存配置才会写入 YAML。
            </span>
          </DialogDescription>
        </DialogHeader>

        <ul
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          data-slot="site-icon-candidates"
        >
          {candidates.map((c) => {
            const isSelected = c.candidateId === selected;
            return (
              <li key={c.candidateId}>
                <button
                  type="button"
                  disabled={importing}
                  onClick={() => setSelected(c.candidateId)}
                  className={cn(
                    "flex w-full flex-col items-center gap-2 rounded-md border p-3 text-left transition-colors",
                    isSelected
                      ? "border-ring bg-accent/50 ring-2 ring-ring"
                      : "border-border/70 hover:border-ring/40 hover:bg-muted/40",
                  )}
                >
                  <span className="flex size-14 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background">
                    <img
                      src={c.previewDataUrl}
                      alt=""
                      className="max-h-12 max-w-12 object-contain"
                    />
                  </span>
                  <span className="w-full truncate text-center text-[11px] text-muted-foreground">
                    {TIER_LABEL[c.tier]}
                    {c.declaredSizes ? ` · ${c.declaredSizes}` : ""}
                  </span>
                  <span className="w-full truncate text-center text-[10px] text-muted-foreground/80">
                    {c.contentType} · {c.byteLength}B
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="ghost"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={importing || selected === null}
            onClick={() => {
              if (selected) onConfirm(selected);
            }}
          >
            {importing ? "导入中…" : "采用此图标"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
