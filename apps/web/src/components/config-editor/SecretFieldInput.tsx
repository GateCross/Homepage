import { useCallback, type JSX } from "react";

import type { SecretFieldView, SecretFieldWrite } from "@homepage/domain";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type SecretFieldInputProps = {
  label: string;
  /** GET 视图状态（用于初始提示） */
  initialStatus?: SecretFieldView["status"];
  value?: SecretFieldWrite | undefined;
  onChange: (next: SecretFieldWrite) => void;
  disabled?: boolean | undefined;
  error?: string | undefined;
  className?: string | undefined;
};

/**
 * 密钥输入：默认仅显示状态；未改 keep；输入非空 set；显式清空 clear。
 * 不预填明文。
 */
export function SecretFieldInput({
  label,
  initialStatus = "unset",
  value,
  onChange,
  disabled,
  error,
  className,
}: SecretFieldInputProps): JSX.Element {
  const mode = value?.mode ?? "keep";
  const configured =
    mode === "keep"
      ? initialStatus === "configured"
      : mode === "set"
        ? (value?.mode === "set" && value.value.length > 0)
        : false;

  const displayValue =
    mode === "set" && value?.mode === "set" ? value.value : "";

  const handleChange = useCallback(
    (raw: string) => {
      if (raw.length === 0) {
        // 用户清空输入：若原本 keep 且已配置，视为显式 clear；否则 keep/unset
        if (mode === "keep" && initialStatus === "configured") {
          onChange({ mode: "clear" });
        } else if (mode === "set") {
          onChange({ mode: "clear" });
        } else {
          onChange({ mode: "keep" });
        }
        return;
      }
      onChange({ mode: "set", value: raw });
    },
    [initialStatus, mode, onChange],
  );

  const handleClear = useCallback(() => {
    onChange({ mode: "clear" });
  }, [onChange]);

  const handleResetKeep = useCallback(() => {
    onChange({ mode: "keep" });
  }, [onChange]);

  let statusText = "未配置";
  if (mode === "clear") statusText = "将清空";
  else if (mode === "set") statusText = "将写入新值";
  else if (configured) statusText = "已配置（保持原值）";

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <span className="text-xs text-muted-foreground">{statusText}</span>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={
            mode === "keep" && initialStatus === "configured"
              ? "••••••••（保持不变）"
              : "输入新值"
          }
          value={displayValue}
          disabled={disabled}
          onChange={(e) => handleChange(e.target.value)}
        />
        {mode !== "keep" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={handleResetKeep}
          >
            还原
          </Button>
        ) : initialStatus === "configured" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={handleClear}
          >
            清空
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
