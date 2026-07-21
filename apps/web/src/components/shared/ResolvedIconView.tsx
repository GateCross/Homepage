import { useState, type JSX } from "react";

import {
  resolveBookmarkIconDisplay,
  resolveIconIdentifier,
  resolveServiceIconDisplay,
  type BookmarkIconDisplay,
  type ResolvedIcon,
  type ServiceIconDisplay,
} from "@/lib/icons";
import { cn } from "@/lib/utils";

function iconifyUrl(icon: Extract<ResolvedIcon, { kind: "mdi" | "si" }>): string {
  if (icon.kind === "mdi") {
    return `https://api.iconify.design/mdi/${encodeURIComponent(icon.name)}.svg`;
  }
  return `https://api.iconify.design/simple-icons/${encodeURIComponent(icon.name)}.svg`;
}

function resolvedIconSrc(icon: ResolvedIcon): string | null {
  switch (icon.kind) {
    case "url":
      return icon.href;
    case "file":
      return `/icons/${encodeURIComponent(icon.filename)}`;
    case "mdi":
    case "si":
      return iconifyUrl(icon);
    default: {
      const _exhaustive: never = icon;
      return _exhaustive;
    }
  }
}

export type IconImageProps = {
  icon: ResolvedIcon;
  alt?: string;
  className?: string;
  onFailed?: () => void;
};

export function IconImage({
  icon,
  alt = "",
  className,
  onFailed,
}: IconImageProps): JSX.Element | null {
  const src = resolvedIconSrc(icon);
  if (src === null) {
    return null;
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      className={cn("size-5 shrink-0 object-contain", className)}
      onError={() => {
        onFailed?.();
      }}
    />
  );
}

/** 无/坏 Icon 时的统一通用占位（书签与服务共用）。 */
export function GenericIconPlaceholder({
  className,
}: {
  className?: string | undefined;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="generic-icon-placeholder"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="10" r="1.5" fill="currentColor" stroke="none" />
        <path d="M4.5 17.5 9 13l3 3 4-5 3.5 4.5" />
      </svg>
    </span>
  );
}

export type ServiceIconViewProps = {
  icon?: string | null | undefined;
  name: string;
  className?: string;
  preferPlaceholder?: boolean;
};

export function ServiceIconView({
  icon,
  name,
  className,
  preferPlaceholder = true,
}: ServiceIconViewProps): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  const display: ServiceIconDisplay = resolveServiceIconDisplay(icon, {
    iconAvailable: !failed,
    preferPlaceholder,
  });

  if (display.kind === "hidden") {
    return null;
  }
  if (display.kind === "placeholder") {
    return className !== undefined ? (
      <GenericIconPlaceholder className={className} />
    ) : (
      <GenericIconPlaceholder />
    );
  }

  const resolved = resolveIconIdentifier(icon);
  if (resolved.kind === "failed") {
    if (!preferPlaceholder) {
      return null;
    }
    return className !== undefined ? (
      <GenericIconPlaceholder className={className} />
    ) : (
      <GenericIconPlaceholder />
    );
  }

  return (
    <span
      data-slot="service-icon"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background/80",
        className,
      )}
      aria-hidden={name ? undefined : true}
    >
      <IconImage
        icon={display.icon}
        alt=""
        className="size-5"
        onFailed={() => setFailed(true)}
      />
    </span>
  );
}

export type BookmarkIconViewProps = {
  icon?: string | null | undefined;
  /** 保留以兼容调用方；不再参与显示回退。 */
  abbr?: string | null | undefined;
  name: string;
  className?: string;
};

export function BookmarkIconView({
  icon,
  abbr,
  name,
  className,
}: BookmarkIconViewProps): JSX.Element {
  const [failed, setFailed] = useState(false);
  const display: BookmarkIconDisplay = resolveBookmarkIconDisplay({
    icon,
    abbr,
    name,
    iconAvailable: !failed,
  });

  if (display.kind === "icon") {
    return (
      <span
        data-slot="bookmark-icon"
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background/80",
          className,
        )}
        aria-hidden="true"
      >
        <IconImage
          icon={display.icon}
          alt=""
          className="size-5"
          onFailed={() => setFailed(true)}
        />
      </span>
    );
  }

  return className !== undefined ? (
    <GenericIconPlaceholder className={className} />
  ) : (
    <GenericIconPlaceholder />
  );
}
