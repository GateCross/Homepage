import { useEffect, useState, type JSX } from "react";

import {
  resolveBookmarkIconDisplay,
  resolveIconIdentifier,
  resolveServiceIconDisplay,
  type BookmarkIconDisplay,
  type ResolvedIcon,
  type ServiceIconDisplay,
} from "@/lib/icons";
import { cn } from "@/lib/utils";

/** 经本站代理拉取 Iconify，避免前端纯 CDN 在离线/阻断时全挂 */
function iconifyUrl(icon: Extract<ResolvedIcon, { kind: "mdi" | "si" }>): string {
  if (icon.kind === "mdi") {
    return `/api/icons/iconify/mdi/${encodeURIComponent(icon.name)}.svg`;
  }
  return `/api/icons/iconify/simple-icons/${encodeURIComponent(icon.name)}.svg`;
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
      key={src}
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

/** 服务/书签图标共用的磁贴底，统一尺寸与玻璃质感。 */
const ICON_TILE_CLASS =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/35 bg-gradient-to-br from-white/55 to-white/20 text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_4px_12px_-6px_rgba(0,0,0,0.35)] ring-1 ring-black/5 backdrop-blur-sm transition-[transform,box-shadow,border-color] duration-150 dark:border-white/12 dark:from-white/12 dark:to-white/[0.04] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_6px_14px_-8px_rgba(0,0,0,0.55)] dark:ring-white/5";

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
      className={cn(ICON_TILE_CLASS, "text-muted-foreground/80", className)}
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
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
  // icon 变更时清除失败态，避免换图标后仍显示占位
  useEffect(() => {
    setFailed(false);
  }, [icon]);
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
        ICON_TILE_CLASS,
        "group-hover:scale-[1.04] group-hover:border-white/50 group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_8px_16px_-8px_rgba(0,0,0,0.4)] dark:group-hover:border-white/18",
        className,
      )}
      aria-hidden={name ? undefined : true}
    >
      <IconImage
        icon={display.icon}
        alt=""
        className="size-[1.35rem]"
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
  useEffect(() => {
    setFailed(false);
  }, [icon]);
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
          ICON_TILE_CLASS,
          "group-hover:scale-[1.04] group-hover:border-white/50 group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_8px_16px_-8px_rgba(0,0,0,0.4)] dark:group-hover:border-white/18",
          className,
        )}
        aria-hidden="true"
      >
        <IconImage
          icon={display.icon}
          alt=""
          className="size-[1.35rem]"
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
