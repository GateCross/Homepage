import { useState, type JSX, type KeyboardEvent } from "react";

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

export type AddGroupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string | undefined;
  description?: string | undefined;
  placeholder?: string | undefined;
  onConfirm: (name: string) => void;
  disabled?: boolean | undefined;
};

/**
 * 添加分组对话框：解决新建分组时无法输入名称的问题，
 * 支持快捷键回车提交、Esc 取消，自动聚焦输入框。
 */
export function AddGroupDialog({
  open,
  onOpenChange,
  title = "添加服务分组",
  description = "输入新分组的名称，创建后可向其中添加服务条目",
  placeholder = "例如：常用工具、媒体影音、开发环境",
  onConfirm,
  disabled,
}: AddGroupDialogProps): JSX.Element {
  const [name, setName] = useState("");

  const handleConfirm = (): void => {
    const trimmed = name.trim();
    onConfirm(trimmed || "新分组");
    setName("");
    onOpenChange(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="add-group-name-input">分组名称</Label>
          <Input
            id="add-group-name-input"
            value={name}
            disabled={disabled}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setName("");
              onOpenChange(false);
            }}
          >
            取消
          </Button>
          <Button type="button" disabled={disabled} onClick={handleConfirm}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
