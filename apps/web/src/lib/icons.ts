import {
  isAbsoluteHttpUrl,
  resolveBookmarkIconFallback,
} from "@homepage/domain";

export type ResolvedIcon =
  | {
      kind: "mdi";

      name: string;

      raw: string;
    }
  | {
      kind: "si";
      name: string;
      raw: string;
    }
  | {
      kind: "url";
      href: string;
      raw: string;
    }
  | {
      kind: "file";

      filename: string;
      raw: string;
    };

export type IconResolveFailure = {
  kind: "failed";
  reason: string;
  raw: string;
};

export type IconResolveResult = ResolvedIcon | IconResolveFailure;

export type ServiceIconDisplay =
  | { kind: "icon"; icon: ResolvedIcon }
  | { kind: "placeholder" }
  | { kind: "hidden" };

export type BookmarkIconDisplay =
  | { kind: "icon"; icon: ResolvedIcon }
  | { kind: "placeholder" };

const MDI_RE = /^mdi-([a-z0-9]+(?:-[a-z0-9]+)*)$/i;
const SI_RE = /^si-([a-z0-9]+(?:-[a-z0-9]+)*)$/i;

const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{1,8}$/;

function isUnsafeHttpUrl(href: string): boolean {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return true;
    }
    // 拒绝带用户名密码的 URL
    if (u.username !== "" || u.password !== "") {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function resolveIconIdentifier(
  raw: string | null | undefined,
): IconResolveResult {
  if (raw === null || raw === undefined) {
    return { kind: "failed", reason: "未配置图标", raw: "" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "failed", reason: "图标标识为空", raw: "" };
  }

  // 绝对 URL
  if (isAbsoluteHttpUrl(trimmed)) {
    if (isUnsafeHttpUrl(trimmed)) {
      return { kind: "failed", reason: "不安全的图标 URL", raw: trimmed };
    }
    return { kind: "url", href: trimmed, raw: trimmed };
  }

  // 协议相对或其它 scheme 一律拒绝
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { kind: "failed", reason: "不支持的图标 URL 协议", raw: trimmed };
  }

  // mdi-
  const mdi = MDI_RE.exec(trimmed);
  if (mdi) {
    return {
      kind: "mdi",
      name: mdi[1]!.toLowerCase(),
      raw: trimmed,
    };
  }

  // si-
  const si = SI_RE.exec(trimmed);
  if (si) {
    return {
      kind: "si",
      name: si[1]!.toLowerCase(),
      raw: trimmed,
    };
  }

  // 同源根相对路径（兼容上游 /images/...、/icons/...）
  const rootRelative = normalizeRootRelativeIconPath(trimmed);
  if (rootRelative !== null) {
    return { kind: "url", href: rootRelative, raw: trimmed };
  }

  // 路径穿越 / 目录分隔
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    return { kind: "failed", reason: "非法图标路径", raw: trimmed };
  }

  // 安全文件名
  if (SAFE_FILENAME_RE.test(trimmed)) {
    return { kind: "file", filename: trimmed, raw: trimmed };
  }

  return { kind: "failed", reason: "无法识别的图标标识", raw: trimmed };
}

const ROOT_RELATIVE_ICON_RE =
  /^\/(?:images|icons)\/[a-zA-Z0-9][a-zA-Z0-9._\-\s]*\.[a-zA-Z0-9]{1,8}$/;

function normalizeRootRelativeIconPath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.includes("..") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  if (!ROOT_RELATIVE_ICON_RE.test(raw)) {
    return null;
  }
  const segments = raw.split("/");
  const encoded = segments
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
  return encoded.startsWith("/") ? encoded : `/${encoded}`;
}

export function resolveServiceIconDisplay(
  raw: string | null | undefined,
  options: {
    iconAvailable?: boolean;
    preferPlaceholder?: boolean;
  } = {},
): ServiceIconDisplay {
  const resolved = resolveIconIdentifier(raw);
  if (resolved.kind === "failed") {
    return options.preferPlaceholder === false
      ? { kind: "hidden" }
      : { kind: "placeholder" };
  }
  if (options.iconAvailable === false) {
    return options.preferPlaceholder === false
      ? { kind: "hidden" }
      : { kind: "placeholder" };
  }
  return { kind: "icon", icon: resolved };
}

export function resolveBookmarkIconDisplay(input: {
  icon?: string | null | undefined;
  abbr?: string | null | undefined;
  name: string;
  iconAvailable?: boolean;
}): BookmarkIconDisplay {
  const resolved = resolveIconIdentifier(input.icon);
  if (resolved.kind !== "failed" && input.iconAvailable !== false) {
    return { kind: "icon", icon: resolved };
  }

  // abbr 保留入参但不参与回退；与领域 resolveBookmarkIconFallback 对齐
  const fallback = resolveBookmarkIconFallback({
    icon: input.icon,
    abbr: input.abbr,
    name: input.name,
    iconAvailable: false,
  });

  if (fallback.kind === "icon") {
    // iconAvailable=false 时领域不会返回 icon；防御性回落占位
    return { kind: "placeholder" };
  }
  return { kind: "placeholder" };
}
