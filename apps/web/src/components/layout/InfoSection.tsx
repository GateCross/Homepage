import type { InfoWidgetConfig } from "@homepage/domain";
import type { JSX } from "react";

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

  return (
    <section
      aria-label={messages.layout.infoSection}
      data-slot="info-section"
      className={cn("w-full", className)}
    >
      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {widgets.map((widget) => (
          <div
            key={widget.infoId}
            data-info-id={widget.infoId}
            data-info-type={widget.type}
            className="overflow-hidden rounded-2xl border border-white/20 bg-card/48 text-card-foreground shadow-[0_12px_32px_-18px_rgba(0,0,0,0.45)] backdrop-blur-xl dark:border-white/10 dark:bg-card/60"
          >
            {renderWidget(widget)}
          </div>
        ))}
      </div>
    </section>
  );
}
