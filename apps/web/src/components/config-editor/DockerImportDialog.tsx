import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import type {
  DockerContainerSummary,
  EditableDockerEndpoint,
  EditableServiceGroupWrite,
  EditableServiceItemWrite,
} from "@/lib/contracts";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { fetchDockerContainers, isApiClientError } from "@/lib/api";
import { formatPublicError, formatUnknownError } from "@/lib/format-error";
import { collectBoundDockerKeys } from "@/lib/service-model";
import { cn } from "@/lib/utils";

export function DockerImportDialog({
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
  // 扫描请求的中止控制：弹窗关闭或重复扫描时掐掉在途请求，避免卸载后 setState
  const scanAbortRef = useRef<AbortController | null>(null);

  const bound = useMemo(() => collectBoundDockerKeys(value), [value]);

  const reset = (): void => {
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    setError(null);
    setContainers([]);
    setSelected(new Set());
    setScanning(false);
    setServer(dockerEndpoints[0]?.name ?? "");
    setGroupIndex(value.length > 0 ? Math.max(0, value.length - 1) : 0);
  };

  // 组件真的被卸载时同样要掐掉在途请求
  useEffect(() => () => {
    scanAbortRef.current?.abort();
  }, []);

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
    // 重复点击时废弃上一次扫描
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;

    setScanning(true);
    setError(null);
    setContainers([]);
    setSelected(new Set());
    try {
      const res = await fetchDockerContainers(server.trim(), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setContainers(res.containers);
      if (res.containers.length === 0) {
        setError("未发现容器");
      }
    } catch (err) {
      if (controller.signal.aborted) return;
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
                <Select
                  value={server}
                  disabled={disabled || scanning}
                  onChange={(e) => setServer(e.target.value)}
                >
                  {dockerEndpoints.map((ep) => (
                    <option key={ep.name} value={ep.name}>
                      {ep.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>目标分组</Label>
                <Select
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
                </Select>
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


