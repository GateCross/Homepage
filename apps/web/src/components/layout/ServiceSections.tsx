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

/** 按分组名哈希选 inset 轻色 wash（伪元素），稳定且不覆盖外阴影。 */
const GROUP_ACCENT_CLASSES = [
  "before:bg-sky-400/12 dark:before:bg-sky-300/10",
  "before:bg-violet-400/12 dark:before:bg-violet-300/10",
  "before:bg-emerald-400/12 dark:before:bg-emerald-300/10",
  "before:bg-amber-400/12 dark:before:bg-amber-300/10",
  "before:bg-rose-400/10 dark:before:bg-rose-300/8",
  "before:bg-cyan-400/12 dark:before:bg-cyan-300/10",
] as const;

function groupAccentClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return GROUP_ACCENT_CLASSES[hash % GROUP_ACCENT_CLASSES.length]!;
}

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

  let riseIndex = 0;

  return (
    <section
      aria-label={messages.layout.servicesSection}
      data-slot="service-sections"
      data-equal-heights={useEqualHeights ? "true" : "false"}
      className={cn("flex w-full flex-col gap-7", className)}
    >
      {groups.map((group) => {
        const maxColumns =
          layout[group.name]?.maxColumns ?? ADAPTIVE_GRID_UNBOUNDED_MAX_COLUMNS;
        const accent = groupAccentClass(group.name);
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
                  const delay = Math.min(riseIndex, 24) * 28;
                  riseIndex += 1;
                  return (
                    <li key={item.id} className="min-h-0 list-none">
                      <ServiceCard
                        service={item}
                        className="h-full"
                        accentClass={accent}
                        riseDelayMs={delay}
                      />
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
