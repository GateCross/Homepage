import type { JSX } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import type { EditableLayoutEntry, EditableSettings } from "@/lib/contracts";

import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
import {
  DragHandle,
  EditorPageHeader,
  IconActionButton,
  useReorderDrag,
} from "@/components/config-editor/EditorListChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type LayoutGroupOption = {
  name: string;
  type: "service" | "bookmark";
};

export type SettingsFormProps = {
  value: EditableSettings;
  onChange: (next: EditableSettings) => void;
  disabled?: boolean | undefined;
  errors?: Record<string, string> | undefined;
  /** 已有的分组选项列表（包含服务与书签），用于来源标识、分组名自动补全与智能默认名推荐 */
  groupOptions?: LayoutGroupOption[] | undefined;
  /** 兼容旧代码的服务分组名称列表 */
  serviceGroupNames?: string[] | undefined;
};

let layoutRowKeySeed = 0;
const layoutRowKeyMap = new WeakMap<EditableLayoutEntry, string>();

/** 为每行生成稳定标识并在更新内容时继承，防止输入时 DOM 重建丢失焦点 */
function getLayoutRowKey(entry: EditableLayoutEntry): string {
  let key = layoutRowKeyMap.get(entry);
  if (!key) {
    key = `layout-row-${++layoutRowKeySeed}`;
    layoutRowKeyMap.set(entry, key);
  }
  return key;
}

export function SettingsForm({
  value,
  onChange,
  disabled,
  errors,
  groupOptions,
  serviceGroupNames,
}: SettingsFormProps): JSX.Element {
  const layoutDrag = useReorderDrag({
    items: value.layout,
    disabled,
    onReorder: (next) => onChange({ ...value, layout: next }),
  });

  // 整理分组选项：优先使用 groupOptions，没有时回退 serviceGroupNames
  const allOptions: LayoutGroupOption[] = groupOptions ?? [
    ...(serviceGroupNames ?? []).map((name) => ({
      name,
      type: "service" as const,
    })),
  ];

  const groupTypeMap = new Map<string, "service" | "bookmark">();
  for (const opt of allOptions) {
    if (opt.name?.trim()) {
      groupTypeMap.set(opt.name.trim(), opt.type);
    }
  }

  const handleGroupNameChange = (index: number, nextName: string): void => {
    const current = value.layout[index];
    if (!current) return;
    const currentKey = getLayoutRowKey(current);
    const nextLayout = value.layout.map((row, i) => {
      if (i !== index) return row;
      const updated = { ...row, groupName: nextName };
      layoutRowKeyMap.set(updated, currentKey);
      return updated;
    });
    onChange({ ...value, layout: nextLayout });
  };

  const handleMaxColumnsChange = (index: number, nextVal: string): void => {
    const current = value.layout[index];
    if (!current) return;
    const currentKey = getLayoutRowKey(current);
    const n = Number(nextVal);
    const nextLayout = value.layout.map((row, i) => {
      if (i !== index) return row;
      const updated = {
        ...row,
        maxColumns: Number.isInteger(n) && n >= 1 ? n : row.maxColumns,
      };
      layoutRowKeyMap.set(updated, currentKey);
      return updated;
    });
    onChange({ ...value, layout: nextLayout });
  };

  const handleAddLayout = (): void => {
    const configured = new Set(value.layout.map((l) => l.groupName.trim()));
    const nextAvailable = allOptions.find(
      (opt) => opt.name.trim() && !configured.has(opt.name.trim()),
    );
    const nextAvailableName = nextAvailable?.name ?? "新分组";

    const newRow: EditableLayoutEntry = {
      groupName: nextAvailableName,
      maxColumns: 4,
    };
    getLayoutRowKey(newRow);
    onChange({
      ...value,
      layout: [...value.layout, newRow],
    });
  };

  const moveLayoutRow = (index: number, direction: "up" | "down"): void => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= value.layout.length) return;
    const next = [...value.layout];
    const [removed] = next.splice(index, 1);
    if (!removed) return;
    next.splice(targetIndex, 0, removed);
    onChange({ ...value, layout: next });
  };

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
              <div>
                <Label>页面布局与分组排序</Label>
                <p className="text-xs text-muted-foreground">
                  调整服务与书签分组在首页的上下展示顺序与最大列数
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={handleAddLayout}
              >
                添加
              </Button>
            </div>
            {value.layout.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无布局配置</p>
            ) : (
              <ul className="space-y-2">
                {value.layout.map((entry, index) => {
                  const rowProps = layoutDrag.getRowProps(index);
                  const groupType = groupTypeMap.get(entry.groupName.trim());
                  return (
                    <li
                      key={getLayoutRowKey(entry)}
                      {...rowProps}
                      className={cn(
                        "grid grid-cols-[auto_auto_minmax(0,1fr)_5.5rem_auto] items-center gap-2 rounded-lg border border-border/60 bg-card/60 p-2 shadow-xs transition-[background-color,opacity,box-shadow,border-color] duration-150",
                        rowProps["data-dragging"] && "opacity-50",
                        rowProps["data-drop-target"] &&
                          "border-primary/50 ring-1 ring-primary/30",
                      )}
                    >
                      <DragHandle
                        disabled={disabled}
                        {...layoutDrag.getHandleProps(index)}
                      />
                      {groupType === "service" ? (
                        <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                          服务
                        </span>
                      ) : groupType === "bookmark" ? (
                        <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          书签
                        </span>
                      ) : (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          自定义
                        </span>
                      )}
                      <Input
                        value={entry.groupName}
                        disabled={disabled}
                        aria-label="分组名"
                        placeholder="分组名"
                        list="settings-group-name-options"
                        onChange={(e) =>
                          handleGroupNameChange(index, e.target.value)
                        }
                      />
                      <Input
                        type="number"
                        min={1}
                        value={entry.maxColumns}
                        disabled={disabled}
                        aria-label="最大列数"
                        onChange={(e) =>
                          handleMaxColumnsChange(index, e.target.value)
                        }
                      />
                      <div className="flex shrink-0 items-center gap-0.5">
                        <IconActionButton
                          label="上移"
                          disabled={disabled || index === 0}
                          onClick={() => moveLayoutRow(index, "up")}
                        >
                          <ArrowUp className="size-3.5" />
                        </IconActionButton>
                        <IconActionButton
                          label="下移"
                          disabled={
                            disabled || index === value.layout.length - 1
                          }
                          onClick={() => moveLayoutRow(index, "down")}
                        >
                          <ArrowDown className="size-3.5" />
                        </IconActionButton>
                        <IconActionButton
                          label="删除该行"
                          disabled={disabled}
                          tone="danger"
                          onClick={() => {
                            onChange({
                              ...value,
                              layout: value.layout.filter(
                                (_, i) => i !== index,
                              ),
                            });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </IconActionButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {allOptions.length > 0 ? (
              <datalist id="settings-group-name-options">
                {allOptions.map((opt) => (
                  <option
                    key={`${opt.type}-${opt.name}`}
                    value={opt.name}
                  >
                    {opt.name} ({opt.type === "service" ? "服务" : "书签"})
                  </option>
                ))}
              </datalist>
            ) : null}
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
