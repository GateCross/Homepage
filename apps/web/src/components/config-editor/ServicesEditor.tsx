import { useMemo, useState, type JSX } from "react";

import type {
  DockerContainerSummary,
  EditableDockerEndpoint,
  EditableServiceGroupWrite,
  EditableServiceItemWrite,
  SecretFieldWrite,
} from "@homepage/domain";

import {
  EditorGroupCard,
  EditorListRow,
  useReorderDrag,
} from "@/components/config-editor/EditorListChrome";
import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
import { SecretFieldInput } from "@/components/config-editor/SecretFieldInput";
import { ServiceIconView } from "@/components/shared/ResolvedIconView";
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
import { Switch } from "@/components/ui/switch";
import {
  fetchDockerContainers,
  isApiClientError,
} from "@/lib/api";
import { formatPublicError, formatUnknownError } from "@/lib/format-error";
import { cn } from "@/lib/utils";

export type ServicesEditorProps = {
  value: EditableServiceGroupWrite[];
  onChange: (next: EditableServiceGroupWrite[]) => void;
  dockerEndpoints?: EditableDockerEndpoint[];
  disabled?: boolean;
  errors?: Record<string, string>;
};

type EditTarget =
  | { kind: "group"; gi: number }
  | { kind: "item"; gi: number; ii: number };

function emptyService(): EditableServiceItemWrite {
  return { name: "新服务" };
}

function emptyGroup(): EditableServiceGroupWrite {
  return { name: "新分组", items: [emptyService()] };
}

function cloneService(item: EditableServiceItemWrite): EditableServiceItemWrite {
  return structuredClone(item);
}

function summarizeHref(href: string | undefined): string | null {
  if (!href?.trim()) return null;
  try {
    const u = new URL(href);
    return u.host || href;
  } catch {
    return href.length > 36 ? `${href.slice(0, 36)}…` : href;
  }
}

function serviceKeywords(item: EditableServiceItemWrite): string[] {
  const tags: string[] = [];
  if (item.hidden === true) tags.push("已隐藏");
  const host = summarizeHref(item.href);
  if (host) tags.push(host);
  if (item.httpProbe?.enabled) tags.push("探测");
  if (item.docker?.container) {
    tags.push(
      item.docker.server
        ? `${item.docker.server}/${item.docker.container}`
        : item.docker.container,
    );
  }
  if (item.widget?.type) tags.push(item.widget.type);
  if (item.description?.trim()) tags.push(item.description.trim());
  return tags;
}

function collectBoundDockerKeys(
  groups: EditableServiceGroupWrite[],
): Set<string> {
  const keys = new Set<string>();
  for (const g of groups) {
    for (const it of g.items) {
      if (it.docker?.server && it.docker.container) {
        keys.add(`${it.docker.server}::${it.docker.container}`);
      }
    }
  }
  return keys;
}

function groupHasItemErrors(
  errors: Record<string, string> | undefined,
  gi: number,
): boolean {
  if (!errors) return false;
  const prefix = `services.${gi}.`;
  return Object.keys(errors).some(
    (k) => k.startsWith(prefix) && k !== `services.${gi}.name`,
  );
}

function itemHasErrors(
  errors: Record<string, string> | undefined,
  gi: number,
  ii: number,
): boolean {
  if (!errors) return false;
  const prefix = `services.${gi}.items.${ii}.`;
  return Object.keys(errors).some((k) => k.startsWith(prefix));
}

function ServiceItemForm({
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

  const selectClass =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

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
                description: e.target.value || undefined,
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
              icon: next?.trim() || undefined,
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
              <select
                className={selectClass}
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
              </select>
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
                <select
                  className={selectClass}
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
                  <option value="emby">emby</option>
                  <option value="customapi">customapi</option>
                </select>
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
              value.widget.type === "customapi") && (
              <SecretFieldInput
                label="密钥 / API Key"
                value={value.widget.key ?? value.widget.apiKey}
                disabled={disabled}
                onChange={(next: SecretFieldWrite) =>
                  patch({
                    widget: { ...value.widget!, key: next },
                  })
                }
              />
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DockerImportDialog({
  open,
  onOpenChange,
  value,
  onChange,
  dockerEndpoints,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: EditableServiceGroupWrite[];
  onChange: (next: EditableServiceGroupWrite[]) => void;
  dockerEndpoints: EditableDockerEndpoint[];
  disabled?: boolean;
}): JSX.Element {
  const [server, setServer] = useState(dockerEndpoints[0]?.name ?? "");
  const [groupIndex, setGroupIndex] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const bound = useMemo(() => collectBoundDockerKeys(value), [value]);

  const reset = (): void => {
    setError(null);
    setContainers([]);
    setSelected(new Set());
    setScanning(false);
    setServer(dockerEndpoints[0]?.name ?? "");
    setGroupIndex(value.length > 0 ? Math.max(0, value.length - 1) : 0);
  };

  const handleOpenChange = (next: boolean): void => {
    if (!next) reset();
    else {
      setServer(dockerEndpoints[0]?.name ?? "");
      setGroupIndex(value.length > 0 ? Math.max(0, value.length - 1) : 0);
    }
    onOpenChange(next);
  };

  const scan = async (): Promise<void> => {
    if (!server.trim()) {
      setError("请选择 Docker 端点");
      return;
    }
    setScanning(true);
    setError(null);
    setContainers([]);
    setSelected(new Set());
    try {
      const res = await fetchDockerContainers(server.trim());
      setContainers(res.containers);
      if (res.containers.length === 0) {
        setError("未发现容器");
      }
    } catch (err) {
      let message = "扫描失败";
      if (isApiClientError(err)) {
        message = err.publicError
          ? formatPublicError(err.publicError, message)
          : err.message || message;
      } else {
        message = formatUnknownError(err, message);
      }
      setError(message);
    } finally {
      setScanning(false);
    }
  };

  const toggle = (name: string, already: boolean): void => {
    if (already) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const apply = (): void => {
    if (selected.size === 0) return;
    const serverName = server.trim();
    const picks = containers.filter((c) => selected.has(c.name));
    if (picks.length === 0) return;

    let next = value.map((g) => ({ ...g, items: [...g.items] }));
    let gi = groupIndex;

    if (next.length === 0) {
      next = [{ name: "Docker", items: [] }];
      gi = 0;
    } else if (gi < 0 || gi >= next.length) {
      gi = next.length - 1;
    }

    const group = next[gi]!;
    const added: EditableServiceItemWrite[] = picks.map((c) => ({
      name: c.name,
      docker: { server: serverName, container: c.name },
    }));
    next[gi] = { ...group, items: [...group.items, ...added] };
    onChange(next);
    handleOpenChange(false);
  };

  const stateLabel = (s: DockerContainerSummary["state"]): string => {
    if (s === "running") return "运行中";
    if (s === "starting") return "启动中";
    if (s === "restarting") return "重启中";
    if (s === "paused") return "已暂停";
    if (s === "stopped") return "已停止";
    return "其他";
  };

  const healthLabel = (
    h: DockerContainerSummary["health"],
  ): string | null => {
    if (h === "healthy") return "健康";
    if (h === "unhealthy") return "不健康";
    if (h === "starting") return "检查中";
    return null;
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>从 Docker 导入</DialogTitle>
          <DialogDescription>
            扫描已配置端点上的容器，勾选后写入草稿；需保存配置才会生效。
          </DialogDescription>
        </DialogHeader>

        {dockerEndpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            请先在「Docker」页添加端点。
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Docker 端点</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={server}
                  disabled={disabled || scanning}
                  onChange={(e) => setServer(e.target.value)}
                >
                  {dockerEndpoints.map((ep) => (
                    <option key={ep.name} value={ep.name}>
                      {ep.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>目标分组</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={String(groupIndex)}
                  disabled={disabled || scanning || value.length === 0}
                  onChange={(e) => setGroupIndex(Number(e.target.value))}
                >
                  {value.length === 0 ? (
                    <option value="0">新建「Docker」分组</option>
                  ) : (
                    value.map((g, i) => (
                      <option key={`g-${i}`} value={String(i)}>
                        {g.name || `分组 ${i + 1}`}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={disabled || scanning || !server}
                onClick={() => void scan()}
              >
                {scanning ? "扫描中…" : "扫描容器"}
              </Button>
            </div>

            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}

            {containers.length > 0 ? (
              <ul className="max-h-64 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60">
                {containers.map((c) => {
                  const key = `${server}::${c.name}`;
                  const already = bound.has(key);
                  const checked = already || selected.has(c.name);
                  return (
                    <li key={c.name}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-2 px-3 py-2 text-sm",
                          already && "cursor-not-allowed opacity-60",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={checked}
                          disabled={already || disabled || scanning}
                          onChange={() => toggle(c.name, already)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{c.name}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {stateLabel(c.state)}
                            {healthLabel(c.health)
                              ? ` · ${healthLabel(c.health)}`
                              : ""}
                            {c.image ? ` · ${c.image}` : ""}
                            {already ? " · 已添加" : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={
              disabled ||
              scanning ||
              selected.size === 0 ||
              dockerEndpoints.length === 0
            }
            onClick={apply}
          >
            添加所选（{selected.size}）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServiceGroupBlock({
  group,
  gi,
  disabled,
  errors,
  dragHandleProps,
  rowProps,
  onEditGroup,
  onDeleteGroup,
  onAddService,
  onEditItem,
  onReorderItems,
  onDeleteItem,
}: {
  group: EditableServiceGroupWrite;
  gi: number;
  disabled?: boolean | undefined;
  errors?: Record<string, string> | undefined;
  dragHandleProps: ReturnType<
    ReturnType<typeof useReorderDrag>["getHandleProps"]
  >;
  rowProps: ReturnType<ReturnType<typeof useReorderDrag>["getRowProps"]>;
  onEditGroup: () => void;
  onDeleteGroup: () => void;
  onAddService: () => void;
  onEditItem: (ii: number) => void;
  onReorderItems: (items: EditableServiceItemWrite[]) => void;
  onDeleteItem: (ii: number) => void;
}): JSX.Element {
  const itemDrag = useReorderDrag({
    items: group.items,
    disabled,
    onReorder: onReorderItems,
  });

  return (
    <EditorGroupCard
      title={group.name || "未命名分组"}
      countLabel={`${group.items.length} 项`}
      hasError={
        Boolean(errors?.[`services.${gi}.name`]) || groupHasItemErrors(errors, gi)
      }
      errorText={errors?.[`services.${gi}.name`]}
      disabled={disabled}
      dragHandleProps={dragHandleProps}
      rowProps={rowProps}
      onEdit={onEditGroup}
      onDelete={onDeleteGroup}
      onAdd={onAddService}
      addLabel="添加服务"
    >
      {group.items.length === 0 ? (
        <li className="px-4 py-6 text-center text-sm text-muted-foreground">
          分组内暂无服务，点右上角 + 添加
        </li>
      ) : null}
      {group.items.map((item, ii) => (
        <EditorListRow
          key={`svc-${gi}-${ii}`}
          icon={
            <ServiceIconView
              icon={item.icon}
              name={item.name || "未命名服务"}
              className="size-8"
            />
          }
          title={item.name || "未命名服务"}
          tags={serviceKeywords(item)}
          hasError={itemHasErrors(errors, gi, ii)}
          disabled={disabled}
          dragHandleProps={itemDrag.getHandleProps(ii)}
          rowProps={itemDrag.getRowProps(ii)}
          onEdit={() => onEditItem(ii)}
          onDelete={() => onDeleteItem(ii)}
        />
      ))}
    </EditorGroupCard>
  );
}

export function ServicesEditor({
  value,
  onChange,
  dockerEndpoints = [],
  disabled,
  errors,
}: ServicesEditorProps): JSX.Element {
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [draftItem, setDraftItem] = useState<EditableServiceItemWrite | null>(
    null,
  );
  const [draftGroupName, setDraftGroupName] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const openItemEdit = (
    gi: number,
    ii: number,
    itemOverride?: EditableServiceItemWrite,
  ): void => {
    const item = itemOverride ?? value[gi]?.items[ii];
    if (!item) return;
    setDraftItem(cloneService(item));
    setEditTarget({ kind: "item", gi, ii });
  };

  const openGroupEdit = (gi: number): void => {
    const group = value[gi];
    if (!group) return;
    setDraftGroupName(group.name);
    setEditTarget({ kind: "group", gi });
  };

  const closeEdit = (): void => {
    setEditTarget(null);
    setDraftItem(null);
    setDraftGroupName("");
  };

  const applyItemEdit = (): void => {
    if (editTarget?.kind !== "item" || !draftItem) return;
    const { gi, ii } = editTarget;
    if (!value[gi]) return;
    onChange(
      value.map((g, i) =>
        i === gi
          ? {
              ...g,
              items: g.items.map((it, idx) => (idx === ii ? draftItem : it)),
            }
          : g,
      ),
    );
    closeEdit();
  };

  const applyGroupEdit = (): void => {
    if (editTarget?.kind !== "group") return;
    const { gi } = editTarget;
    onChange(
      value.map((g, i) =>
        i === gi ? { ...g, name: draftGroupName } : g,
      ),
    );
    closeEdit();
  };

  const updateGroup = (
    gi: number,
    patch: Partial<EditableServiceGroupWrite>,
  ): void => {
    onChange(value.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  };

  const addServiceAndEdit = (gi: number): void => {
    const group = value[gi];
    if (!group) return;
    const created = emptyService();
    const nextItems = [...group.items, created];
    onChange(
      value.map((g, i) => (i === gi ? { ...g, items: nextItems } : g)),
    );
    openItemEdit(gi, nextItems.length - 1, created);
  };

  const groupDrag = useReorderDrag({
    items: value,
    disabled,
    onReorder: onChange,
  });

  const dialogOpen = editTarget !== null;

  const dialogTitle = useMemo(() => {
    if (editTarget?.kind === "group") return "编辑分组";
    if (editTarget?.kind === "item") return "编辑服务";
    return "";
  }, [editTarget]);

  const itemErrorPrefix =
    editTarget?.kind === "item"
      ? `services.${editTarget.gi}.items.${editTarget.ii}`
      : "";

  return (
    <div className="space-y-4" data-slot="services-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          拖拽左侧手柄可调整分组与服务顺序
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setImportOpen(true)}
          >
            从 Docker 导入
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...value, emptyGroup()])}
          >
            添加分组
          </Button>
        </div>
      </div>

      {value.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
          暂无服务分组
        </p>
      ) : null}

      <div className="space-y-3">
        {value.map((group, gi) => (
          <ServiceGroupBlock
            key={`svc-g-${gi}`}
            group={group}
            gi={gi}
            disabled={disabled}
            errors={errors}
            dragHandleProps={groupDrag.getHandleProps(gi)}
            rowProps={groupDrag.getRowProps(gi)}
            onEditGroup={() => openGroupEdit(gi)}
            onDeleteGroup={() => onChange(value.filter((_, i) => i !== gi))}
            onAddService={() => addServiceAndEdit(gi)}
            onEditItem={(ii) => openItemEdit(gi, ii)}
            onReorderItems={(items) => updateGroup(gi, { items })}
            onDeleteItem={(ii) =>
              updateGroup(gi, {
                items: group.items.filter((_, idx) => idx !== ii),
              })
            }
          />
        ))}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {editTarget?.kind === "item"
                ? "修改后点确定写回列表，再保存配置才会生效。"
                : "修改分组名称，点确定写回列表。"}
            </DialogDescription>
          </DialogHeader>

          {editTarget?.kind === "group" ? (
            <div className="space-y-1">
              <Label>分组名称</Label>
              <Input
                value={draftGroupName}
                disabled={disabled}
                onChange={(e) => setDraftGroupName(e.target.value)}
                autoFocus
              />
              {errors?.[`services.${editTarget.gi}.name`] ? (
                <p className="text-xs text-destructive">
                  {errors[`services.${editTarget.gi}.name`]}
                </p>
              ) : null}
            </div>
          ) : null}

          {editTarget?.kind === "item" && draftItem ? (
            <ServiceItemForm
              value={draftItem}
              onChange={setDraftItem}
              {...(disabled !== undefined ? { disabled } : {})}
              errorPrefix={itemErrorPrefix}
              {...(errors !== undefined ? { errors } : {})}
              dockerEndpoints={dockerEndpoints}
            />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeEdit}>
              取消
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (editTarget?.kind === "group") applyGroupEdit();
                else applyItemEdit();
              }}
            >
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DockerImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        value={value}
        onChange={onChange}
        dockerEndpoints={dockerEndpoints}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    </div>
  );
}
