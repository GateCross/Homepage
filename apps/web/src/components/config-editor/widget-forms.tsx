import type { JSX } from "react";

import type { EditableServiceWidgetWrite } from "@/lib/contracts";

import { SecretFieldInput } from "@/components/config-editor/SecretFieldInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  CADDY_FIELD_OPTIONS,
  CUSTOM_API_FORMAT_OPTIONS,
  EMBY_FIELD_OPTIONS,
  IMMICH_FIELD_OPTIONS,
} from "@/lib/service-model";
import { cn } from "@/lib/utils";

type WidgetWrite = EditableServiceWidgetWrite;

/** 组件选项表单的公共入参 */
type WidgetFormProps = {
  widget: WidgetWrite;
  disabled?: boolean | undefined;
  onChange: (next: WidgetWrite) => void;
};

function OptionSwitchRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="space-y-0.5 pr-3">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

// 空 fields 表示全选；切换后若恰好全选或全空则回到 undefined（全展示）。
export function toggleFieldList(
  allOptions: readonly { id: string }[],
  current: readonly string[],
  id: string,
  on: boolean,
): string[] | undefined {
  const allSelected = current.length === 0;
  if (allSelected) {
    const next = allOptions
      .map((f) => f.id)
      .filter((fid) => (fid === id ? on : true));
    return next.length === allOptions.length ? undefined : next;
  }
  const set = new Set(current);
  if (on) set.add(id);
  else set.delete(id);
  const next = allOptions.map((f) => f.id).filter((fid) => set.has(fid));
  return next.length === 0 || next.length === allOptions.length
    ? undefined
    : next;
}

/** 多选字段网格；空 fields 视为全选。 */
function CheckboxFieldGrid({
  options,
  fields,
  disabled,
  columns,
  onToggle,
}: {
  options: readonly { id: string; label: string }[];
  fields: readonly string[];
  disabled?: boolean | undefined;
  columns: 3 | 4;
  onToggle: (id: string, on: boolean) => void;
}): JSX.Element {
  const allSelected = fields.length === 0;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2",
        columns === 4 ? "sm:grid-cols-4" : "sm:grid-cols-3",
      )}
    >
      {options.map((opt) => {
        const checked = allSelected || fields.includes(opt.id);
        return (
          <label key={opt.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-3.5 rounded border-border"
              checked={checked}
              disabled={disabled}
              onChange={(e) => onToggle(opt.id, e.target.checked)}
            />
            {opt.label}
          </label>
        );
      })}
    </div>
  );
}

/** 多选字段网格的公共外壳，供三个「展示字段」区块复用。 */
function FieldGridSection({
  title,
  options,
  fields,
  disabled,
  columns,
  onToggle,
}: {
  title: string;
  options: readonly { id: string; label: string }[];
  fields: readonly string[];
  disabled?: boolean | undefined;
  columns: 3 | 4;
  onToggle: (id: string, on: boolean) => void;
}): JSX.Element {
  return (
    <div className="space-y-2 rounded-lg border border-border/50 bg-muted/10 px-3 py-2.5">
      <Label>{title}</Label>
      <p className="text-xs text-muted-foreground">
        不勾选任何项时显示全部字段
      </p>
      <CheckboxFieldGrid
        options={options}
        fields={fields}
        disabled={disabled}
        columns={columns}
        onToggle={onToggle}
      />
    </div>
  );
}

function EmbyWidgetOptionsForm({
  widget,
  disabled,
  onChange,
}: WidgetFormProps): JSX.Element {
  const fields = widget.fields ?? [];

  const toggleField = (id: string, on: boolean): void => {
    onChange({
      ...widget,
      fields: toggleFieldList(EMBY_FIELD_OPTIONS, fields, id, on),
    });
  };

  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      <p className="text-xs font-medium text-muted-foreground">Emby 展示选项</p>
      <OptionSwitchRow
        label="媒体库数量"
        description="显示电影 / 剧集 / 集数 / 歌曲数量"
        checked={widget.enableBlocks === true}
        disabled={disabled}
        onCheckedChange={(checked) =>
          onChange({ ...widget, enableBlocks: checked })
        }
      />
      {widget.enableBlocks === true ? (
        <FieldGridSection
          title="数量字段"
          options={EMBY_FIELD_OPTIONS}
          fields={fields}
          disabled={disabled}
          columns={4}
          onToggle={toggleField}
        />
      ) : null}
      <OptionSwitchRow
        label="正在播放"
        description="显示当前播放会话与数量"
        checked={widget.enableNowPlaying !== false}
        disabled={disabled}
        onCheckedChange={(checked) =>
          onChange({ ...widget, enableNowPlaying: checked })
        }
      />
      <OptionSwitchRow
        label="显示用户"
        description="会话行展示播放用户名"
        checked={widget.enableUser === true}
        disabled={disabled || widget.enableNowPlaying === false}
        onCheckedChange={(checked) =>
          onChange({ ...widget, enableUser: checked })
        }
      />
      <OptionSwitchRow
        label="显示季集号"
        description="剧集会话附加 Sxx · Exx"
        checked={widget.showEpisodeNumber === true}
        disabled={disabled || widget.enableNowPlaying === false}
        onCheckedChange={(checked) =>
          onChange({ ...widget, showEpisodeNumber: checked })
        }
      />
    </div>
  );
}

function ImmichWidgetOptionsForm({
  widget,
  disabled,
  onChange,
}: WidgetFormProps): JSX.Element {
  const fields = widget.fields ?? [];
  const version = widget.version === 2 ? 2 : 1;

  const toggleField = (id: string, on: boolean): void => {
    onChange({
      ...widget,
      fields: toggleFieldList(IMMICH_FIELD_OPTIONS, fields, id, on),
    });
  };

  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      <p className="text-xs font-medium text-muted-foreground">Immich 选项</p>
      <div className="space-y-1.5">
        <Label>API 版本</Label>
        <p className="text-xs text-muted-foreground">
          Immich ≥ v1.118 请选 2；旧版选 1
        </p>
        <Select
          value={String(version)}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...widget,
              version: e.target.value === "2" ? 2 : 1,
            })
          }
        >
          <option value="1">1（server-info）</option>
          <option value="2">2（server）</option>
        </Select>
      </div>
      <FieldGridSection
        title="展示字段"
        options={IMMICH_FIELD_OPTIONS}
        fields={fields}
        disabled={disabled}
        columns={4}
        onToggle={toggleField}
      />
    </div>
  );
}

function CaddyWidgetOptionsForm({
  widget,
  disabled,
  onChange,
}: WidgetFormProps): JSX.Element {
  const fields = widget.fields ?? [];

  const toggleField = (id: string, on: boolean): void => {
    onChange({
      ...widget,
      fields: toggleFieldList(CADDY_FIELD_OPTIONS, fields, id, on),
    });
  };

  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      <p className="text-xs font-medium text-muted-foreground">Caddy 选项</p>
      <p className="text-xs text-muted-foreground">
        组件 URL 应为 Caddy 管理 API（默认 :2019），不是站点入口
      </p>
      <FieldGridSection
        title="展示字段"
        options={CADDY_FIELD_OPTIONS}
        fields={fields}
        disabled={disabled}
        columns={3}
        onToggle={toggleField}
      />
    </div>
  );
}

function CustomApiWidgetOptionsForm({
  widget,
  disabled,
  onChange,
}: WidgetFormProps): JSX.Element {
  const headers = widget.headers ?? [];
  const mappings = widget.mappings ?? [];

  const updateHeader = (
    index: number,
    patch: Partial<(typeof headers)[number]>,
  ): void => {
    const next = headers.map((h, i) => (i === index ? { ...h, ...patch } : h));
    onChange({ ...widget, headers: next });
  };

  const removeHeader = (index: number): void => {
    const next = headers.filter((_, i) => i !== index);
    onChange({ ...widget, headers: next.length > 0 ? next : undefined });
  };

  const addHeader = (): void => {
    onChange({
      ...widget,
      headers: [...headers, { name: "", value: { mode: "set", value: "" } }],
    });
  };

  const updateMapping = (
    index: number,
    patch: Partial<(typeof mappings)[number]>,
  ): void => {
    const next = mappings.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onChange({ ...widget, mappings: next });
  };

  const removeMapping = (index: number): void => {
    const next = mappings.filter((_, i) => i !== index);
    onChange({ ...widget, mappings: next.length > 0 ? next : undefined });
  };

  const addMapping = (): void => {
    onChange({
      ...widget,
      mappings: [
        ...mappings,
        { label: "", field: "", path: "", format: "number" },
      ],
    });
  };

  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      <p className="text-xs font-medium text-muted-foreground">
        Custom API 选项
      </p>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>请求头</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={addHeader}
          >
            添加
          </Button>
        </div>
        {headers.length === 0 ? (
          <p className="text-xs text-muted-foreground">无自定义请求头</p>
        ) : (
          <div className="space-y-2">
            {headers.map((h, index) => (
              <div
                key={`header-${index}`}
                className="grid gap-2 rounded-lg border border-border/50 bg-muted/10 p-2 sm:grid-cols-[1fr_1fr_auto]"
              >
                <div className="space-y-1">
                  <Label className="text-xs">名称</Label>
                  <Input
                    value={h.name}
                    disabled={disabled}
                    placeholder="Authorization"
                    onChange={(e) =>
                      updateHeader(index, { name: e.target.value })
                    }
                  />
                </div>
                <SecretFieldInput
                  label="值"
                  value={h.value}
                  disabled={disabled}
                  onChange={(next) => updateHeader(index, { value: next })}
                />
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => removeHeader(index)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>字段映射</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={addMapping}
          >
            添加
          </Button>
        </div>
        {mappings.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            未配置映射时组件无指标
          </p>
        ) : (
          <div className="space-y-2">
            {mappings.map((m, index) => (
              <div
                key={`mapping-${index}`}
                className="space-y-2 rounded-lg border border-border/50 bg-muted/10 p-2"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">标签</Label>
                    <Input
                      value={m.label ?? ""}
                      disabled={disabled}
                      placeholder="温度"
                      onChange={(e) =>
                        updateMapping(index, {
                          label: e.target.value || undefined,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">字段 ID</Label>
                    <Input
                      value={m.field ?? m.id ?? ""}
                      disabled={disabled}
                      placeholder="temp"
                      onChange={(e) =>
                        updateMapping(index, {
                          field: e.target.value || undefined,
                          id: e.target.value || undefined,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">JSON 路径</Label>
                    <Input
                      value={m.path ?? ""}
                      disabled={disabled}
                      placeholder="data.temp"
                      onChange={(e) =>
                        updateMapping(index, {
                          path: e.target.value || undefined,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">格式</Label>
                    <Select
                      value={m.format ?? "number"}
                      disabled={disabled}
                      onChange={(e) =>
                        updateMapping(index, {
                          format: e.target.value || undefined,
                        })
                      }
                    >
                      {CUSTOM_API_FORMAT_OPTIONS.map((fmt) => (
                        <option key={fmt} value={fmt}>
                          {fmt}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => removeMapping(index)}
                  >
                    删除映射
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 按组件类型分发到对应选项表单；未知类型不渲染额外选项。 */
export function WidgetOptionsForm(props: WidgetFormProps): JSX.Element | null {
  switch (props.widget.type) {
    case "emby":
      return <EmbyWidgetOptionsForm {...props} />;
    case "immich":
      return <ImmichWidgetOptionsForm {...props} />;
    case "caddy":
      return <CaddyWidgetOptionsForm {...props} />;
    case "customapi":
      return <CustomApiWidgetOptionsForm {...props} />;
    default:
      return null;
  }
}
