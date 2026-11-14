import type { JSX } from "react";
import { Trash2 } from "lucide-react";

import type { EditableSettings } from "@/lib/contracts";

import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
import {
  EditorPageHeader,
} from "@/components/config-editor/EditorListChrome";
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
      <EditorPageHeader
        title="基础设置"
        description="标题、背景图、站点图标与首页布局"
      />

      {/* 左列常规（标题/等高/布局），右列外观（背景图/图标），铺满内容区 */}
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
        <div className="space-y-6">
          <div className="space-y-1.5">
            <Label htmlFor="settings-title">标题</Label>
            <Input
              id="settings-title"
              value={value.title}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, title: e.target.value })}
            />
            {errors?.["settings.title"] ? (
              <p className="text-xs text-destructive">
                {errors["settings.title"]}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="space-y-0.5 pr-3">
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
                    className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-center gap-2 rounded-lg border border-border/60 p-2"
                  >
                    <Input
                      value={entry.groupName}
                      disabled={disabled}
                      aria-label="分组名"
                      placeholder="分组名"
                      onChange={(e) => {
                        const layout = value.layout.map((row, i) =>
                          i === index
                            ? { ...row, groupName: e.target.value }
                            : row,
                        );
                        onChange({ ...value, layout });
                      }}
                    />
                    <Input
                      type="number"
                      min={1}
                      value={entry.maxColumns}
                      disabled={disabled}
                      aria-label="最大列数"
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        const layout = value.layout.map((row, i) =>
                          i === index
                            ? {
                                ...row,
                                maxColumns:
                                  Number.isInteger(n) && n >= 1
                                    ? n
                                    : row.maxColumns,
                              }
                            : row,
                        );
                        onChange({ ...value, layout });
                      }}
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label="删除该行"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        onChange({
                          ...value,
                          layout: value.layout.filter((_, i) => i !== index),
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <ImageAssetField
            id="settings-bg"
            label="背景图"
            value={value.background ?? ""}
            {...(disabled !== undefined ? { disabled } : {})}
            preview="background"
            placeholder="可选，绝对 http(s) 或 /images/... 路径"
            onChange={(next) => {
              // 空串清除；与 merge 语义一致
              onChange({ ...value, background: next });
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
              onChange({ ...value, favicon: next });
            }}
          />
        </div>
      </div>
    </div>
  );
}
