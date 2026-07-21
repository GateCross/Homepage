import type { JSX } from "react";

import type { EditableSettings } from "@homepage/domain";

import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type SettingsFormProps = {
  value: EditableSettings;
  onChange: (next: EditableSettings) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
};

export function SettingsForm({
  value,
  onChange,
  disabled,
  errors,
}: SettingsFormProps): JSX.Element {
  return (
    <div className="space-y-6" data-slot="settings-form">
      <div className="space-y-1.5">
        <Label htmlFor="settings-title">标题</Label>
        <Input
          id="settings-title"
          value={value.title}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
        />
        {errors?.["settings.title"] ? (
          <p className="text-xs text-destructive">{errors["settings.title"]}</p>
        ) : null}
      </div>

      <ImageAssetField
        id="settings-bg"
        label="背景图"
        value={value.background ?? ""}
        {...(disabled !== undefined ? { disabled } : {})}
        preview="background"
        placeholder="可选，绝对 http(s) 或 /images/... 路径"
        onChange={(next) => {
          if (next === undefined) {
            const { background: _b, ...rest } = value;
            void _b;
            onChange(rest);
          } else {
            onChange({ ...value, background: next });
          }
        }}
      />

      <ImageAssetField
        id="settings-favicon"
        label="站点图标"
        value={value.favicon ?? ""}
        {...(disabled !== undefined ? { disabled } : {})}
        preview="icon"
        placeholder="可选，绝对 http(s) 或 /images/... 路径"
        hint="用于浏览器标签页与首页标题旁"
        onChange={(next) => {
          if (next === undefined) {
            const { favicon: _f, ...rest } = value;
            void _f;
            onChange(rest);
          } else {
            onChange({ ...value, favicon: next });
          }
        }}
      />

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="settings-equal">服务卡片等高</Label>
          <p className="text-xs text-muted-foreground">
            开启后同一行卡片保持相同高度
          </p>
        </div>
        <Switch
          id="settings-equal"
          checked={value.useEqualHeights}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ ...value, useEqualHeights: checked })
          }
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>服务分组最大列数</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                layout: [
                  ...value.layout,
                  { groupName: "新分组", maxColumns: 3 },
                ],
              })
            }
          >
            添加
          </Button>
        </div>
        {value.layout.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无布局配置</p>
        ) : (
          <ul className="space-y-2">
            {value.layout.map((entry, index) => (
              <li
                key={`${entry.groupName}-${index}`}
                className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-3"
              >
                <div className="min-w-[8rem] flex-1 space-y-1">
                  <Label>分组名</Label>
                  <Input
                    value={entry.groupName}
                    disabled={disabled}
                    onChange={(e) => {
                      const layout = value.layout.map((row, i) =>
                        i === index
                          ? { ...row, groupName: e.target.value }
                          : row,
                      );
                      onChange({ ...value, layout });
                    }}
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Label>最大列数</Label>
                  <Input
                    type="number"
                    min={1}
                    value={entry.maxColumns}
                    disabled={disabled}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      const layout = value.layout.map((row, i) =>
                        i === index
                          ? {
                              ...row,
                              maxColumns:
                                Number.isInteger(n) && n >= 1 ? n : row.maxColumns,
                            }
                          : row,
                      );
                      onChange({ ...value, layout });
                    }}
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    onChange({
                      ...value,
                      layout: value.layout.filter((_, i) => i !== index),
                    });
                  }}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
