import { describe, expect, it } from "vitest";

import type { EditableConfigWrite } from "@homepage/domain";

import type { ParsedConfigSources } from "../load-config.js";
import { mergeEditableIntoSources } from "./merge-sources.js";

function emptySources(
  overrides: Partial<ParsedConfigSources> = {},
): ParsedConfigSources {
  return {
    settings: { title: "Home" },
    services: [],
    bookmarks: [],
    widgets: [],
    docker: {},
    presentFiles: [],
    missingFiles: [],
    ...overrides,
  };
}

function baseWrite(
  overrides: Partial<EditableConfigWrite> = {},
): EditableConfigWrite {
  return {
    settings: {
      title: "Home",
      useEqualHeights: false,
      layout: [],
    },
    services: [],
    bookmarks: [],
    infoWidgets: [],
    dockerEndpoints: [],
    ...overrides,
  };
}

describe("mergeInfoWidgets 身份匹配", () => {
  it("重排后按 type 对应磁盘条目，未知键不串位", () => {
    const sources = emptySources({
      widgets: [
        { type: "datetime", timezone: "Asia/Shanghai", customA: 1 },
        { type: "resources", cpu: true, customB: 2 },
      ],
    });

    const merged = mergeEditableIntoSources(
      baseWrite({
        infoWidgets: [
          { type: "resources", cpu: true },
          { type: "datetime", timezone: "Asia/Shanghai" },
        ],
      }),
      sources,
    );

    const widgets = merged.widgets as Array<Record<string, unknown>>;
    expect(widgets[0]?.["type"]).toBe("resources");
    expect(widgets[0]?.["customB"]).toBe(2);
    expect(widgets[0]?.["customA"]).toBeUndefined();
    expect(widgets[1]?.["type"]).toBe("datetime");
    expect(widgets[1]?.["customA"]).toBe(1);
    expect(widgets[1]?.["customB"]).toBeUndefined();
  });
});

describe("mergeServices 同名分组", () => {
  it("按出现顺序对应同名分组，不共用第一组基底", () => {
    const sources = emptySources({
      services: [
        { Media: [{ name: "A", keepA: true }] },
        { Media: [{ name: "B", keepB: true }] },
      ],
    });

    const merged = mergeEditableIntoSources(
      baseWrite({
        services: [
          { name: "Media", items: [{ name: "A" }] },
          { name: "Media", items: [{ name: "B" }] },
        ],
      }),
      sources,
    );

    const groups = merged.services as Array<Record<string, unknown[]>>;
    const firstItems = groups[0]?.["Media"] as Array<Record<string, unknown>>;
    const secondItems = groups[1]?.["Media"] as Array<Record<string, unknown>>;
    expect(firstItems[0]?.["keepA"]).toBe(true);
    expect(firstItems[0]?.["keepB"]).toBeUndefined();
    expect(secondItems[0]?.["keepB"]).toBe(true);
    expect(secondItems[0]?.["keepA"]).toBeUndefined();
  });
});
