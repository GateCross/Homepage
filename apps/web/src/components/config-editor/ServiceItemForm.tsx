import type { JSX } from "react";

import type {
  EditableDockerEndpoint,
  EditableServiceItemWrite,
  SecretFieldWrite,
} from "@/lib/contracts";

import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
import { SecretFieldInput } from "@/components/config-editor/SecretFieldInput";
import { WidgetOptionsForm } from "@/components/config-editor/widget-forms";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export function ServiceItemForm({
  value,
  onChange,
  disabled,
  errorPrefix,
  errors,
  dockerEndpoints,
}: {
  value: EditableServiceItemWrite;
  onChange: (next: EditableServiceItemWrite) => void;
  disabled?: boolean;
  errorPrefix: string;
  errors?: Record<string, string>;
  dockerEndpoints: EditableDockerEndpoint[];
}): JSX.Element {
  const patch = (partial: Partial<EditableServiceItemWrite>): void => {
    onChange({ ...value, ...partial });
  };

  const endpointNames = dockerEndpoints.map((e) => e.name).filter(Boolean);

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>名称</Label>
            <Input
              value={value.name}
              disabled={disabled}
              onChange={(e) => patch({ name: e.target.value })}
            />
            {errors?.[`${errorPrefix}.name`] ? (
              <p className="text-xs text-destructive">
                {errors[`${errorPrefix}.name`]}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>链接</Label>
            <Input
              value={value.href ?? ""}
              disabled={disabled}
              placeholder="https://…"
              onChange={(e) => {
                const v = e.target.value;
                patch(v.trim() ? { href: v } : { href: undefined });
              }}
            />
            {errors?.[`${errorPrefix}.href`] ? (
              <p className="text-xs text-destructive">
                {errors[`${errorPrefix}.href`]}
              </p>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>描述</Label>
          <Input
            value={value.description ?? ""}
            disabled={disabled}
            placeholder="可选"
            onChange={(e) =>
              patch({
                // 空串表示清除；undefined 会在 merge 时保留磁盘原值
                description: e.target.value,
              })
            }
          />
        </div>

        <ImageAssetField
          label="图标"
          value={value.icon ?? ""}
          {...(disabled !== undefined ? { disabled } : {})}
          preview="icon"
          placeholder="mdi-xxx / si-xxx / URL / /images/..."
          hint="支持图标名、URL、上传，或在填写链接后从站点获取"
          siteIconSourceUrl={value.href ?? ""}
          onChange={(next) =>
            patch({
              // 空串清除；undefined 会在 merge 时保留磁盘原值
              icon: next.trim(),
            })
          }
        />

        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
          <div className="space-y-0.5 pr-3">
            <Label>隐藏</Label>
            <p className="text-xs text-muted-foreground">
              开启后不在首页与搜索中显示
            </p>
          </div>
          <Switch
            checked={value.hidden === true}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patch({ hidden: checked ? true : undefined })
            }
          />
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label>HTTP 探测</Label>
            <p className="text-xs text-muted-foreground">
              首页显示可达性与延迟
            </p>
          </div>
          <Switch
            checked={value.httpProbe?.enabled === true}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patch({
                httpProbe: checked
                  ? {
                      enabled: true,
                      ...(value.httpProbe?.url
                        ? { url: value.httpProbe.url }
                        : {}),
                    }
                  : undefined,
              })
            }
          />
        </div>
        {value.httpProbe?.enabled ? (
          <div className="space-y-1.5 border-t border-border/50 pt-3">
            <Label>探测 URL</Label>
            <Input
              value={value.httpProbe.url ?? ""}
              disabled={disabled}
              placeholder="可空，默认用上方链接"
              onChange={(e) =>
                patch({
                  httpProbe: {
                    enabled: true,
                    url: e.target.value || undefined,
                    ...(value.httpProbe?.expectedStatus
                      ? {
                          expectedStatus: value.httpProbe.expectedStatus,
                        }
                      : {}),
                    ...(value.httpProbe?.timeoutSec !== undefined
                      ? { timeoutSec: value.httpProbe.timeoutSec }
                      : {}),
                  },
                })
              }
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-3">
        <div className="space-y-0.5">
          <Label>Docker 绑定</Label>
          <p className="text-xs text-muted-foreground">
            绑定后首页显示运行状态、健康与资源占用
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">端点</Label>
            {endpointNames.length > 0 ? (
              <Select
                value={value.docker?.server ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const server = e.target.value.trim();
                  const container = value.docker?.container ?? "";
                  if (!server && !container) {
                    patch({ docker: undefined });
                  } else {
                    patch({
                      docker: {
                        server: server || endpointNames[0] || "my-docker",
                        container: container || "container",
                      },
                    });
                  }
                }}
              >
                <option value="">（无）</option>
                {endpointNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={value.docker?.server ?? ""}
                disabled={disabled}
                placeholder="先在 Docker 页添加端点"
                onChange={(e) => {
                  const server = e.target.value.trim();
                  const container = value.docker?.container ?? "";
                  if (!server && !container) {
                    patch({ docker: undefined });
                  } else {
                    patch({
                      docker: {
                        server: server || "my-docker",
                        container: container || "container",
                      },
                    });
                  }
                }}
              />
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">容器名</Label>
            <Input
              value={value.docker?.container ?? ""}
              disabled={disabled}
              placeholder="docker ps 中的名称"
              onChange={(e) => {
                const container = e.target.value.trim();
                const server = value.docker?.server ?? "";
                if (!server && !container) {
                  patch({ docker: undefined });
                } else {
                  patch({
                    docker: {
                      server: server || endpointNames[0] || "my-docker",
                      container: container || "container",
                    },
                  });
                }
              }}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-dashed border-border/70 bg-card/30 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label>服务组件</Label>
            <p className="text-xs text-muted-foreground">
              展示业务数据（如下载速度、正在播放）
            </p>
          </div>
          <Switch
            checked={value.widget !== undefined}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patch({
                widget: checked
                  ? {
                      type: "qbittorrent",
                      url: value.href ?? "http://127.0.0.1",
                    }
                  : undefined,
              })
            }
          />
        </div>
        {value.widget ? (
          <div className="space-y-3 border-t border-border/50 pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select
                  value={value.widget.type}
                  disabled={disabled}
                  onChange={(e) =>
                    patch({
                      widget: {
                        ...value.widget!,
                        type: e.target.value,
                      },
                    })
                  }
                >
                  <option value="qbittorrent">qbittorrent</option>
                  <option value="transmission">transmission</option>
                  <option value="emby">emby</option>
                  <option value="immich">immich</option>
                  <option value="caddy">caddy</option>
                  <option value="customapi">customapi</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>组件 URL</Label>
                <Input
                  value={value.widget.url ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    patch({
                      widget: {
                        ...value.widget!,
                        url: e.target.value || undefined,
                      },
                    })
                  }
                />
              </div>
            </div>
            {(value.widget.type === "qbittorrent" ||
              value.widget.type === "transmission" ||
              value.widget.type === "customapi") && (
              <div className="grid gap-3 sm:grid-cols-2">
                <SecretFieldInput
                  label="用户名"
                  value={value.widget.username}
                  disabled={disabled}
                  onChange={(next: SecretFieldWrite) =>
                    patch({
                      widget: { ...value.widget!, username: next },
                    })
                  }
                />
                <SecretFieldInput
                  label="密码"
                  value={value.widget.password}
                  disabled={disabled}
                  onChange={(next: SecretFieldWrite) =>
                    patch({
                      widget: { ...value.widget!, password: next },
                    })
                  }
                />
              </div>
            )}
            {(value.widget.type === "emby" ||
              value.widget.type === "immich" ||
              value.widget.type === "customapi") && (
              <SecretFieldInput
                label="密钥 / API Key"
                value={value.widget.key ?? value.widget.apiKey}
                disabled={disabled}
                onChange={(next: SecretFieldWrite) => {
                  // key / apiKey 历史双字段：写回时统一策略，避免只清一侧
                  if (next.mode === "clear") {
                    patch({
                      widget: {
                        ...value.widget!,
                        key: { mode: "clear" },
                        apiKey: { mode: "clear" },
                      },
                    });
                    return;
                  }
                  if (next.mode === "set") {
                    patch({
                      widget: {
                        ...value.widget!,
                        key: next,
                        apiKey: { mode: "clear" },
                      },
                    });
                    return;
                  }
                  patch({
                    widget: {
                      ...value.widget!,
                      key: { mode: "keep" },
                      ...(value.widget!.apiKey !== undefined
                        ? { apiKey: { mode: "keep" as const } }
                        : {}),
                    },
                  });
                }}
              />
            )}
            
            
            
            
            <WidgetOptionsForm
              widget={value.widget}
              {...(disabled !== undefined ? { disabled } : {})}
              onChange={(next) => patch({ widget: next })}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
