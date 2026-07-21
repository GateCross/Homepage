import {
  SERVICE_MIN_ITEM_WIDTH_PX,
  type NormalizedConfig,
  type ServiceGroupItem,
} from "@homepage/domain";
import type { JSX } from "react";

import { EmptyStatus } from "@/components/error";
import {
  ADAPTIVE_GRID_UNBOUNDED_MAX_COLUMNS,
  AdaptiveGrid,
} from "@/components/layout/AdaptiveGrid";
import { CollapsibleGroup } from "@/components/layout/CollapsibleGroup";
import { ServiceCard } from "@/components/services";
import { messages } from "@/lib/messages";
import { cn } from "@/lib/utils";

export type ServiceSectionsProps = {
  groups: NormalizedConfig["services"];
  layout: NormalizedConfig["settings"]["layout"];
  useEqualHeights: boolean;
  className?: string;
};

function isServiceError(
  item: ServiceGroupItem,
): item is Extract<ServiceGroupItem, { kind: "error" }> {
  return "kind" in item && item.kind === "error";
}

function countRenderableItems(
  groups: NormalizedConfig["services"],
): number {
  let total = 0;
  for (const group of groups) {
    total += group.items.length;
  }
  return total;
}

export function ServiceSections({
  groups,
  layout,
  useEqualHeights,
  className,
}: ServiceSectionsProps): JSX.Element {
  const hasContent = groups.length > 0 && countRenderableItems(groups) > 0;

  if (!hasContent) {
    return (
      <section
        aria-label={messages.layout.servicesSection}
        data-slot="service-sections"
        className={cn("w-full", className)}
      >
        <EmptyStatus message={messages.empty.services} />
      </section>
    );
  }

  return (
    <section
      aria-label={messages.layout.servicesSection}
      data-slot="service-sections"
      data-equal-heights={useEqualHeights ? "true" : "false"}
      className={cn("flex w-full flex-col gap-6", className)}
    >
      {groups.map((group) => {
        const maxColumns =
          layout[group.name]?.maxColumns ?? ADAPTIVE_GRID_UNBOUNDED_MAX_COLUMNS;
        return (
          <CollapsibleGroup
            key={group.name}
            scope="services"
            name={group.name}
            count={group.items.length}
            data-slot="service-group"
            data-group-name={group.name}
            data-max-columns={
              layout[group.name]?.maxColumns !== undefined
                ? layout[group.name]?.maxColumns
                : undefined
            }
          >
            {group.items.length === 0 ? (
              <EmptyStatus message={messages.empty.services} />
            ) : (
              <AdaptiveGrid
                as="ul"
                minItemWidth={SERVICE_MIN_ITEM_WIDTH_PX}
                maxColumns={maxColumns}
                useEqualHeights={useEqualHeights}
                gap={10}
              >
                {group.items.map((item, index) => {
                  if (isServiceError(item)) {
                    return (
                      <li
                        key={`${group.name}-error-${index}`}
                        className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive backdrop-blur-md"
                      >
                        {item.message}
                      </li>
                    );
                  }
                  return (
                    <li key={item.id} className="min-h-0 list-none">
                      <ServiceCard service={item} className="h-full" />
                    </li>
                  );
                })}
              </AdaptiveGrid>
            )}
          </CollapsibleGroup>
        );
      })}
    </section>
  );
}
