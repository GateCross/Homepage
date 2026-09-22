import type { JSX } from "react";
import type { EditableServiceItemWrite } from "@homepage/domain";

import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export type ServiceBasicFormProps = {
  item: EditableServiceItemWrite;
  onChange: (patch: Partial<EditableServiceItemWrite>) => void;
  groupNames: string[];
  currentGroup: string;
  onGroupChange: (groupName: string) => void;
  errors?: Record<string, string>;
};

export function ServiceBasicForm({
  item,
  onChange,
  groupNames,
  currentGroup,
  onGroupChange,
  errors = {},
}: ServiceBasicFormProps): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="service-name">服务名称 *</Label>
          <Input
            id="service-name"
            value={item.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="例如：Nextcloud"
            className="mt-1"
          />
          {errors["name"] && (
            <p className="mt-1 text-xs text-destructive">{errors["name"]}</p>
          )}
        </div>

        <div>
          <Label htmlFor="service-group">所属分组</Label>
          <Select
            id="service-group"
            value={currentGroup}
            onChange={(e) => onGroupChange(e.target.value)}
            className="mt-1"
          >
            {groupNames.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="service-href">访问地址 (URL)</Label>
          <Input
            id="service-href"
            value={item.href ?? ""}
            onChange={(e) =>
              onChange({
                href: e.target.value.trim() ? e.target.value : undefined,
              })
            }
            placeholder="https://cloud.example.com"
            className="mt-1"
          />
          {errors["href"] && (
            <p className="mt-1 text-xs text-destructive">{errors["href"]}</p>
          )}
        </div>

        <div>
          <Label htmlFor="service-target">打开方式</Label>
          <Select
            id="service-target"
            value={item.target ?? "_blank"}
            onChange={(e) =>
              onChange({
                target: (e.target.value as "_blank" | "_self") ?? "_blank",
              })
            }
            className="mt-1"
          >
            <option value="_blank">新窗口打开 (_blank)</option>
            <option value="_self">当前窗口打开 (_self)</option>
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="service-desc">描述信息</Label>
        <Input
          id="service-desc"
          value={item.description ?? ""}
          onChange={(e) =>
            onChange({
              description: e.target.value.trim() ? e.target.value : undefined,
            })
          }
          placeholder="简短说明该服务用途"
          className="mt-1"
        />
      </div>

      <div>
        <ImageAssetField
          label="服务图标"
          value={item.icon ?? ""}
          onChange={(icon) => onChange({ icon: icon || undefined })}
          siteIconSourceUrl={item.href}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border/70 p-3">
        <div>
          <Label htmlFor="service-hidden" className="cursor-pointer">
            隐藏此服务
          </Label>
          <p className="text-xs text-muted-foreground">
            不在首页展示，但保留配置
          </p>
        </div>
        <Switch
          id="service-hidden"
          checked={item.hidden === true}
          onCheckedChange={(checked) => onChange({ hidden: checked || undefined })}
        />
      </div>
    </div>
  );
}
