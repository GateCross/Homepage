import type { JSX } from "react";

import type {
  EditableDockerEndpoint,
  EditableInfoWidget,
} from "@homepage/domain";

import { WeatherCityPicker } from "@/components/config-editor/WeatherCityPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  moveItemDown,
  moveItemUp,
} from "@/lib/config-editor/validation";

export type InfoWidgetsEditorProps = {
  value: EditableInfoWidget[];
  onChange: (next: EditableInfoWidget[]) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
};

export type DockerEndpointsEditorProps = {
  value: EditableDockerEndpoint[];
  onChange: (next: EditableDockerEndpoint[]) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
};

/** 将 disk 字段格式化为输入框文案：path|别名，逗号分隔 */
function formatDiskField(
  disk:
    | string
    | Array<string | { path: string; label?: string | undefined }>
    | undefined,
): string {
  if (disk === undefined) return "";
  if (typeof disk === "string") return disk;
  return disk
    .map((item) => {
      if (typeof item === "string") return item;
      const label = item.label?.trim();
      return label && label.length > 0 ? `${item.path}|${label}` : item.path;
    })
    .join(", ");
}

export function InfoWidgetsEditor({
  value,
  onChange,
  disabled,
  errors,
}: InfoWidgetsEditorProps): JSX.Element {
  const updateAt = (index: number, next: EditableInfoWidget): void => {
    onChange(value.map((w, i) => (i === index ? next : w)));
  };

  return (
    <div className="space-y-4" data-slot="info-widgets-editor">
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onChange([...value, { type: "datetime", timezone: "Asia/Shanghai" }])
          }
        >
          添加日期时间
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...value,
              {
                type: "openmeteo",
                cityId: "101020100",
                location: "上海",
              },
            ])
          }
        >
          添加天气
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...value,
              { type: "resources", cpu: true, memory: true, disk: "/" },
            ])
          }
        >
          添加资源
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无信息组件</p>
      ) : null}

      <ul className="space-y-3">
        {value.map((w, i) => (
          <li
            key={`info-${i}`}
            className="space-y-2 rounded-md border border-border/60 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {w.type === "datetime"
                  ? "日期时间"
                  : w.type === "openmeteo"
                    ? "天气"
                    : "资源占用"}
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || i === 0}
                  onClick={() => onChange(moveItemUp(value, i))}
                >
                  上移
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || i >= value.length - 1}
                  onClick={() => onChange(moveItemDown(value, i))}
                >
                  下移
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                >
                  删除
                </Button>
              </div>
            </div>

            {errors?.[`infoWidgets.${i}`] ? (
              <p className="text-xs text-destructive">
                {errors[`infoWidgets.${i}`]}
              </p>
            ) : null}

            {w.type === "datetime" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>时区</Label>
                  <Input
                    value={w.timezone ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      updateAt(i, {
                        ...w,
                        timezone: e.target.value || undefined,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>标签</Label>
                  <Input
                    value={w.label ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      updateAt(i, {
                        ...w,
                        label: e.target.value || undefined,
                      })
                    }
                  />
                </div>
              </div>
            ) : null}

            {w.type === "openmeteo" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label>城市</Label>
                  <WeatherCityPicker
                    cityId={w.cityId}
                    location={w.location}
                    {...(disabled !== undefined ? { disabled } : {})}
                    onSelect={(city) =>
                      updateAt(i, {
                        ...w,
                        cityId: city.cityId,
                        location: city.name,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>标签</Label>
                  <Input
                    value={w.label ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      updateAt(i, {
                        ...w,
                        label: e.target.value || undefined,
                      })
                    }
                  />
                </div>
              </div>
            ) : null}

            {w.type === "resources" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>CPU</Label>
                  <Switch
                    checked={w.cpu !== false}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updateAt(i, { ...w, cpu: checked })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label>内存</Label>
                  <Switch
                    checked={w.memory !== false}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updateAt(i, { ...w, memory: checked })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>磁盘</Label>
                  <Input
                    value={formatDiskField(w.disk)}
                    disabled={disabled}
                    placeholder="/|系统盘, /home/data|数据盘"
                    onChange={(e) => {
                      // 输入过程保留原文字符串，保存时再拆分 path|别名
                      const raw = e.target.value;
                      updateAt(i, {
                        ...w,
                        disk: raw.length === 0 ? undefined : raw,
                      });
                    }}
                  />
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    多块盘用逗号分隔；可用{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                      路径|别名
                    </code>{" "}
                    自定义展示名，例如{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                      /home/data|数据盘
                    </code>
                  </p>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DockerEndpointsEditor({
  value,
  onChange,
  disabled,
  errors,
}: DockerEndpointsEditorProps): JSX.Element {
  return (
    <div className="space-y-4" data-slot="docker-endpoints-editor">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...value,
              { name: "my-docker", connection: "unix:///var/run/docker.sock" },
            ])
          }
        >
          添加端点
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        仅支持新增、删除与修改；不提供调序。连接串请使用 unix://、tcp://host:port
        或 https://host:port（TLS，自签可连），勿内嵌用户名密码。
      </p>

      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无 Docker 端点</p>
      ) : null}

      <ul className="space-y-3">
        {value.map((ep, i) => (
          <li
            key={`docker-${i}`}
            className="grid gap-2 rounded-md border border-border/60 p-3 sm:grid-cols-[1fr_2fr_auto]"
          >
            <div className="space-y-1">
              <Label>名称</Label>
              <Input
                value={ep.name}
                disabled={disabled}
                onChange={(e) =>
                  onChange(
                    value.map((row, idx) =>
                      idx === i ? { ...row, name: e.target.value } : row,
                    ),
                  )
                }
              />
              {errors?.[`dockerEndpoints.${i}.name`] ? (
                <p className="text-xs text-destructive">
                  {errors[`dockerEndpoints.${i}.name`]}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label>连接串</Label>
              <Input
                value={ep.connection}
                disabled={disabled}
                autoComplete="off"
                onChange={(e) =>
                  onChange(
                    value.map((row, idx) =>
                      idx === i
                        ? { ...row, connection: e.target.value }
                        : row,
                    ),
                  )
                }
              />
              {errors?.[`dockerEndpoints.${i}.connection`] ? (
                <p className="text-xs text-destructive">
                  {errors[`dockerEndpoints.${i}.connection`]}
                </p>
              ) : null}
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              >
                删除
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
