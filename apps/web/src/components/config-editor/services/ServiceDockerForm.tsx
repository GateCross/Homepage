import { useEffect, useState, type JSX } from "react";
import type {
  DockerContainerSummary,
  EditableDockerEndpoint,
  EditableServiceDocker,
} from "@homepage/domain";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { fetchDockerContainers } from "@/lib/api";

export type ServiceDockerFormProps = {
  docker: EditableServiceDocker | undefined;
  onChange: (docker: EditableServiceDocker | undefined) => void;
  dockerEndpoints: EditableDockerEndpoint[];
};

export function ServiceDockerForm({
  docker,
  onChange,
  dockerEndpoints,
}: ServiceDockerFormProps): JSX.Element {
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const selectedServer = docker?.server ?? dockerEndpoints[0]?.name ?? "";

  useEffect(() => {
    if (!selectedServer) {
      setContainers([]);
      return;
    }

    let active = true;
    setLoading(true);
    setLoadError(null);

    fetchDockerContainers(selectedServer)
      .then((res) => {
        if (active) {
          setContainers(res.containers ?? []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setLoadError(err instanceof Error ? err.message : "获取容器失败");
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedServer]);

  const handleServerSelect = (server: string): void => {
    if (!server) {
      onChange(undefined);
    } else {
      onChange({ server, container: docker?.container ?? "" });
    }
  };

  const handleContainerSelect = (container: string): void => {
    if (!container) {
      if (!docker?.server) {
        onChange(undefined);
      } else {
        onChange({ server: docker.server, container: "" });
      }
    } else {
      onChange({ server: selectedServer, container });
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="docker-server">Docker 服务器</Label>
          <Select
            id="docker-server"
            value={docker?.server ?? ""}
            onChange={(e) => handleServerSelect(e.target.value)}
            className="mt-1"
          >
            <option value="">(不绑定 Docker)</option>
            {dockerEndpoints.map((ep) => (
              <option key={ep.name} value={ep.name}>
                {ep.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="docker-container">容器名称</Label>
          <Input
            id="docker-container"
            value={docker?.container ?? ""}
            onChange={(e) =>
              onChange(
                docker?.server
                  ? { server: docker.server, container: e.target.value }
                  : undefined,
              )
            }
            placeholder="例如：nginx"
            className="mt-1"
            disabled={!docker?.server}
          />
        </div>
      </div>

      {docker?.server && (
        <div className="rounded-lg border border-border/50 bg-muted/20 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {loading ? "正在获取当前端点容器列表..." : `已发现 ${containers.length} 个容器`}
            </span>
            {loadError && (
              <span className="text-xs text-destructive">{loadError}</span>
            )}
          </div>

          {containers.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
              {containers.map((c) => {
                const isSelected = docker?.container === c.name;
                return (
                  <Button
                    key={c.name}
                    type="button"
                    variant={isSelected ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleContainerSelect(c.name)}
                  >
                    {c.name}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
