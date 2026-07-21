import { normalizeAbsoluteHttpUrl } from "@homepage/domain";

export const SAFE_LINK_TARGETS = ["_blank", "_self"] as const;

export type SafeLinkTarget = (typeof SAFE_LINK_TARGETS)[number];

export type ResolvedSafeHref =
  | { ok: true; href: string; target: SafeLinkTarget; rel?: string }
  | { ok: false; reason: "invalid_href" | "unsafe_target" };

const SAFE_TARGET_SET = new Set<string>(SAFE_LINK_TARGETS);

export function isSafeLinkTarget(value: string | null | undefined): value is SafeLinkTarget {
  if (value === null || value === undefined) {
    return false;
  }
  return SAFE_TARGET_SET.has(value.trim());
}

export function resolveSafeHref(
  href: string | null | undefined,
  target: string | null | undefined,
): ResolvedSafeHref {
  if (typeof href !== "string") {
    return { ok: false, reason: "invalid_href" };
  }
  // 与身份规范化一致：剥 userinfo / hash，仅保留安全 http(s) 绝对 URL
  const normalizedHref = normalizeAbsoluteHttpUrl(href);
  if (normalizedHref === null) {
    return { ok: false, reason: "invalid_href" };
  }
  const rawTarget =
    typeof target === "string" && target.trim().length > 0
      ? target.trim()
      : "_blank";
  if (!isSafeLinkTarget(rawTarget)) {
    return { ok: false, reason: "unsafe_target" };
  }
  if (rawTarget === "_blank") {
    return {
      ok: true,
      href: normalizedHref,
      target: "_blank",
      rel: "noopener noreferrer",
    };
  }
  return { ok: true, href: normalizedHref, target: "_self" };
}

export function openSafeHref(
  href: string | null | undefined,
  target: string | null | undefined,
): boolean {
  const resolved = resolveSafeHref(href, target);
  if (!resolved.ok) {
    return false;
  }
  if (resolved.target === "_blank") {
    const opened = window.open(resolved.href, "_blank", "noopener,noreferrer");
    if (opened) {
      try {
        opened.opener = null;
      } catch {
        // ignore
      }
    }
    return true;
  }
  window.location.assign(resolved.href);
  return true;
}
