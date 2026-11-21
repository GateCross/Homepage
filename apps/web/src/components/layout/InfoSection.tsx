import type { InfoWidgetConfig } from "@/lib/contracts";
import type { CSSProperties, JSX } from "react";

import {
  EmptyStatus,
  UnsupportedStatus,
} from "@/components/error";
import {
  DateTimeWidget,
  OpenMeteoWidget,
  ResourcesWidget,
} from "@/components/info";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

export type InfoSectionProps = {
  widgets: readonly InfoWidgetConfig[];
  className?: string;
};

function renderWidget(widget: InfoWidgetConfig): JSX.Element {
  if (widget.unsupported) {
    return <UnsupportedStatus message={messages.unsupported.info} />;
  }

  switch (widget.type) {
    case "datetime":
      return widget.options !== undefined ? (
        <DateTimeWidget options={widget.options} />
      ) : (
        <DateTimeWidget />
      );
    case "openmeteo":
      return <OpenMeteoWidget infoId={widget.infoId} />;
    case "resources":
      return <ResourcesWidget infoId={widget.infoId} />;
    default:
      return <UnsupportedStatus message={messages.unsupported.info} />;
  }
}

/**
 * 响应式 Bento 栅格跨度：
 * - 中屏（iPad 等 md:grid-cols-2）下卡片数为奇数时，末卡跨 2 列铺满整行，避免第二排右侧留空；
 * - 桌面端（lg:）恰好 3 张且为「天气 + 时间 + 资源」时走 12 栅格非对称比例（5 / 4 / 3），其余均分。
 */
function resolveBentoSpan(
  widgets: readonly InfoWidgetConfig[],
  widget: InfoWidgetConfig,
  index: number,
): string | undefined {
  const isOddLastOnMd =
    widgets.length >= 3 &&
    widgets.length % 2 === 1 &&
    index === widgets.length - 1;

  if (widgets.length === 3) {
    const types = new Set(widgets.map((w) => w.type));
    let lgSpan = "lg:col-span-4";
    if (
      types.size === 3 &&
      types.has("openmeteo") &&
      types.has("datetime") &&
      types.has("resources")
    ) {
      if (widget.type === "openmeteo") lgSpan = "lg:col-span-5";
      else if (widget.type === "datetime") lgSpan = "lg:col-span-4";
      else if (widget.type === "resources") lgSpan = "lg:col-span-3";
    }
    return isOddLastOnMd ? cn("md:col-span-2", lgSpan) : lgSpan;
  }

  if (isOddLastOnMd) {
    return "md:col-span-2 lg:col-span-1";
  }

  return undefined;
}

export function InfoSection({
  widgets,
  className,
}: InfoSectionProps): JSX.Element {
  if (widgets.length === 0) {
    return (
      <section
        aria-label={messages.layout.infoSection}
        data-slot="info-section"
        className={cn("w-full", className)}
      >
        <EmptyStatus message={messages.empty.info} />
      </section>
    );
  }

  const useBento12 = widgets.length === 3;

  return (
    <section
      aria-label={messages.layout.infoSection}
      data-slot="info-section"
      className={cn("w-full", className)}
    >
      <div
        className={cn(
          "grid gap-3.5",
          useBento12
            ? "md:grid-cols-2 lg:grid-cols-12"
            : widgets.length === 1
              ? "grid-cols-1"
              : widgets.length === 2
                ? "md:grid-cols-2"
                : "md:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {widgets.map((widget, index) => (
          <div
            key={widget.infoId}
            data-info-id={widget.infoId}
            data-info-type={widget.type}
            className={cn(
              "surface-info homepage-rise relative flex h-full flex-col overflow-hidden rounded-2xl",
              resolveBentoSpan(widgets, widget, index),
            )}
            style={
              {
                ["--homepage-rise-delay"]: `${index * 60}ms`,
              } as CSSProperties
            }
          >
            {renderWidget(widget)}
          </div>
        ))}
      </div>
    </section>
  );
}
