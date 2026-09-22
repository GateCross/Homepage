import type { JSX } from "react";
import type { EditableHttpProbe } from "@homepage/domain";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type ServiceProbeFormProps = {
  probe: EditableHttpProbe | undefined;
  onChange: (probe: EditableHttpProbe | undefined) => void;
  serviceHref: string | undefined;
  errors?: Record<string, string>;
};

export function ServiceProbeForm({
  probe,
  onChange,
  serviceHref,
  errors = {},
}: ServiceProbeFormProps): JSX.Element {
  const enabled = probe?.enabled ?? false;

  const handleToggle = (checked: boolean): void => {
    if (!checked) {
      onChange(undefined);
    } else {
      onChange({
        enabled: true,
        url: probe?.url,
        expectedStatus: probe?.expectedStatus ?? "200-299",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-border/70 p-3">
        <div>
          <Label htmlFor="probe-enabled" className="cursor-pointer">
            启用 HTTP 健康探测
          </Label>
          <p className="text-xs text-muted-foreground">
            定期检查该服务是否可达并在卡片上显示状态徽标
          </p>
        </div>
        <Switch
          id="probe-enabled"
          checked={enabled}
          onCheckedChange={handleToggle}
        />
      </div>

      {enabled && (
        <div className="space-y-4 rounded-lg border border-border/50 bg-muted/20 p-4">
          <div>
            <Label htmlFor="probe-url">自定义探测 URL（可选）</Label>
            <Input
              id="probe-url"
              value={probe?.url ?? ""}
              onChange={(e) =>
                onChange({
                  ...probe,
                  enabled: true,
                  url: e.target.value.trim() ? e.target.value : undefined,
                })
              }
              placeholder={serviceHref ? `缺省使用服务地址：${serviceHref}` : "https://example.com/health"}
              className="mt-1"
            />
            {errors["httpProbe.url"] && (
              <p className="mt-1 text-xs text-destructive">{errors["httpProbe.url"]}</p>
            )}
          </div>

          <div>
            <Label htmlFor="probe-expected">期望 HTTP 状态码区间</Label>
            <Input
              id="probe-expected"
              value={probe?.expectedStatus ?? "200-299"}
              onChange={(e) =>
                onChange({
                  ...probe,
                  enabled: true,
                  expectedStatus: e.target.value,
                })
              }
              placeholder="例如：200, 204, 200-299, 301, 302"
              className="mt-1"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              支持逗号分隔单个状态码或连字符范围，例如：200, 204, 200-299, 301-308
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
