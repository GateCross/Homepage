import type { AnchorHTMLAttributes, JSX, ReactNode } from "react";

import { resolveSafeHref } from "@/lib/safe-link";
import { cn } from "@/lib/utils";

export type SafeExternalLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target" | "rel"
> & {
  href?: string | null | undefined;
  target?: string | null | undefined;
  children: ReactNode;
  fallbackAsSpan?: boolean;
};

export function SafeExternalLink({
  href,
  target,
  children,
  className,
  fallbackAsSpan = true,
  onClick,
  ...rest
}: SafeExternalLinkProps): JSX.Element {
  const resolved = resolveSafeHref(href, target);

  if (!resolved.ok) {
    if (fallbackAsSpan) {
      return (
        <span
          data-slot="safe-external-link"
          data-link-state="invalid"
          className={cn(className)}
          {...(rest as Record<string, unknown>)}
        >
          {children}
        </span>
      );
    }
    return (
      <a
        data-slot="safe-external-link"
        data-link-state="invalid"
        role="link"
        aria-disabled="true"
        className={cn("pointer-events-none", className)}
        onClick={(event) => {
          event.preventDefault();
          onClick?.(event);
        }}
        {...rest}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      data-slot="safe-external-link"
      data-link-state="valid"
      href={resolved.href}
      target={resolved.target}
      {...(resolved.rel !== undefined ? { rel: resolved.rel } : {})}
      className={cn(className)}
      onClick={onClick}
      {...rest}
    >
      {children}
    </a>
  );
}
