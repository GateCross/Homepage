import type { CSSProperties, KeyboardEvent, JSX } from "react";

import type { NormalizedService } from "@homepage/domain";

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
  /** 分组轻色点缀，叠加在玻璃底上 */
  accentClass?: string;
  /** 入场 stagger 延迟（ms） */
  riseDelayMs?: number;
};

export function ServiceCard({
  service,
  className,
  accentClass,
  riseDelayMs,
}: ServiceCardProps): JSX.Element {
  const link = resolveSafeHref(service.href, service.target);
  const isNavigable = link.ok;
  const showProbe =
    Boolean(service.httpProbe?.enabled && service.httpProbe.probeId);
  const showDocker = Boolean(service.docker);
  const showTopStatus = showProbe || showDocker;
  const hasBottomStatus = Boolean(service.docker || service.widget);

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
      <div className="relative z-[1] flex items-start gap-3">
        <ServiceIconView icon={service.icon} name={service.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-[0.9rem] font-semibold leading-snug tracking-tight text-foreground">
              {service.name}
            </h3>
            {showTopStatus ? (
              <div
                className="flex shrink-0 items-center gap-2 pt-0.5"
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
                  <ProbeSlot probeId={service.httpProbe!.probeId!} />
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
          className="relative z-[1] mt-1.5 flex flex-col gap-1 empty:hidden"
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
    "group homepage-rise relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/25 bg-card/45 p-3 text-left shadow-[0_10px_28px_-14px_rgba(0,0,0,0.4)] backdrop-blur-md transition-[border-color,background-color,box-shadow,transform] duration-200 dark:border-white/10 dark:bg-card/55",
    accentClass &&
      "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:content-['']",
    accentClass,
    isNavigable &&
      "cursor-pointer hover:-translate-y-0.5 hover:border-primary/35 hover:bg-card/68 hover:shadow-[0_16px_32px_-14px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:border-primary/40 dark:hover:bg-card/72",
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
