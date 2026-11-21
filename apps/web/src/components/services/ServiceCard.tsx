import type { CSSProperties, KeyboardEvent, JSX } from "react";

import type { NormalizedService } from "@/lib/contracts";

import { DockerSlot } from "@/components/services/DockerSlot";
import { ProbeSlot } from "@/components/services/ProbeSlot";
import { WidgetSlot } from "@/components/services/WidgetSlot";
import { ServiceIconView } from "@/components/shared/ResolvedIconView";
import { SafeExternalLink } from "@/components/ui/safe-external-link";
import { openSafeHref, resolveSafeHref } from "@/lib/safe-link";
import { cn } from "@/lib/utils";

export type ServiceCardProps = {
  service: NormalizedService;
  className?: string;
  /** 入场 stagger 延迟（ms） */
  riseDelayMs?: number;
};

export function ServiceCard({
  service,
  className,
  riseDelayMs,
}: ServiceCardProps): JSX.Element {
  const link = resolveSafeHref(service.href, service.target);
  const isNavigable = link.ok;
  const showProbe =
    Boolean(service.httpProbe?.enabled && service.httpProbe.probeId);
  const showDocker = Boolean(service.docker);
  const showTopStatus = showProbe || showDocker;
  const hasBottomStatus = Boolean(service.docker ?? service.widget);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!isNavigable) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSafeHref(service.href, service.target);
    }
  };

  const body = (
    <>
      <div
        className={cn(
          "relative z-[1] flex gap-3",
          service.description ? "items-start" : "items-center",
        )}
      >
        {/* 移动端磁贴收紧到 32px，单列列表下降低整卡高度；桌面维持 36px */}
        <ServiceIconView
          icon={service.icon}
          name={service.name}
          className="size-8 sm:size-9"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <h3
              className="min-w-0 flex-1 truncate text-[0.9rem] font-semibold leading-snug tracking-tight text-foreground transition-colors group-hover:text-primary"
              title={service.name}
            >
              {service.name}
            </h3>
            {showTopStatus ? (
              <div
                className="flex shrink-0 items-center gap-1.5"
                // 避免点到状态区域时触发整卡跳转
                onClick={(e) => e.preventDefault()}
              >
                {showDocker ? (
                  <DockerSlot
                    server={service.docker!.server}
                    container={service.docker!.container}
                    mode="badge"
                  />
                ) : null}
                {showProbe ? (
                  <ProbeSlot
                    probeId={service.httpProbe!.probeId}
                    suppressOkIcon={showDocker}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          {service.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
              {service.description}
            </p>
          ) : null}
        </div>
      </div>

      {hasBottomStatus ? (
        <div
          className="relative z-[1] mt-auto flex flex-col gap-1.5 pt-2.5 empty:hidden"
          // 避免点到底部状态/组件区时触发整卡外链跳转
          onClick={(e) => e.preventDefault()}
        >
          {service.docker ? (
            <DockerSlot
              server={service.docker.server}
              container={service.docker.container}
              mode="metrics"
            />
          ) : null}

          {service.widget ? (
            <WidgetSlot
              {...(service.widget.widgetId !== undefined
                ? { widgetId: service.widget.widgetId }
                : {})}
              {...(service.widget.type !== undefined
                ? { widgetType: service.widget.type }
                : {})}
              {...(service.widget.unsupported !== undefined
                ? { unsupported: service.widget.unsupported }
                : {})}
              {...(service.widget.error !== undefined
                ? { configError: service.widget.error }
                : {})}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );

  const shellClass = cn(
    "group surface-card homepage-rise relative flex h-full min-h-0 flex-col justify-center overflow-hidden rounded-xl p-3.5 text-left",
    hasBottomStatus && "justify-start",
    isNavigable &&
      "surface-card-interactive cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
    !isNavigable && "cursor-default",
    className,
  );

  const riseStyle: CSSProperties | undefined =
    riseDelayMs !== undefined
      ? ({
          ["--homepage-rise-delay"]: `${riseDelayMs}ms`,
        } as CSSProperties)
      : undefined;

  if (isNavigable) {
    return (
      <SafeExternalLink
        href={service.href}
        target={service.target}
        data-slot="service-card"
        data-service-id={service.id}
        data-navigable="true"
        className={shellClass}
        style={riseStyle}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {body}
      </SafeExternalLink>
    );
  }

  return (
    <div
      data-slot="service-card"
      data-service-id={service.id}
      data-navigable="false"
      className={shellClass}
      style={riseStyle}
    >
      {body}
    </div>
  );
}
