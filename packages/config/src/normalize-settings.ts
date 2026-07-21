import {
  normalizeTitle,
  type NormalizedSettings,
} from "@homepage/domain";

import { createDefaultSettings } from "./empty.js";

function normalizeMaxColumns(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  if (!Number.isInteger(raw) || raw < 1) {
    return undefined;
  }
  // 防御性上限，避免异常大整数进入前端布局计算
  if (raw > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return raw;
}

function normalizeLayout(raw: unknown): NormalizedSettings["layout"] {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const layout: NormalizedSettings["layout"] = {};

  for (const [groupName, groupValue] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const name = groupName.trim();
    if (name.length === 0) {
      continue;
    }
    if (
      groupValue === null ||
      groupValue === undefined ||
      typeof groupValue !== "object" ||
      Array.isArray(groupValue)
    ) {
      continue;
    }

    const columns = (groupValue as Record<string, unknown>)["columns"];
    const maxColumns = normalizeMaxColumns(columns);
    if (maxColumns === undefined) {
      continue;
    }

    layout[name] = { maxColumns };
  }

  return layout;
}

function normalizeBackground(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (
    raw !== null &&
    raw !== undefined &&
    typeof raw === "object" &&
    !Array.isArray(raw)
  ) {
    const image = (raw as Record<string, unknown>)["image"];
    if (typeof image === "string") {
      const trimmed = image.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }
  return undefined;
}

function normalizeOptionalPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUseEqualHeights(raw: unknown): boolean {
  return raw === true;
}

export function normalizeSettings(raw: unknown): NormalizedSettings {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return createDefaultSettings();
  }

  const source = raw as Record<string, unknown>;

  // language、headerStyle 及任何未知键：读入后不写入结果（安全忽略）
  void source["language"];
  void source["headerStyle"];

  const settings: NormalizedSettings = {
    title: normalizeTitle(source["title"]),
    useEqualHeights: normalizeUseEqualHeights(source["useEqualHeights"]),
    layout: normalizeLayout(source["layout"]),
  };

  const background = normalizeBackground(source["background"]);
  if (background !== undefined) {
    settings.background = background;
  }

  const favicon = normalizeOptionalPath(source["favicon"]);
  if (favicon !== undefined) {
    settings.favicon = favicon;
  }

  return settings;
}
