import { describe, expect, it } from "vitest";

import { parseThemeMode } from "./theme";

describe("parseThemeMode", () => {
  it("识别三种合法模式", () => {
    expect(parseThemeMode("light")).toBe("light");
    expect(parseThemeMode("dark")).toBe("dark");
    expect(parseThemeMode("system")).toBe("system");
  });

  it("非法值一律回落 system", () => {
    expect(parseThemeMode(undefined)).toBe("system");
    expect(parseThemeMode(null)).toBe("system");
    expect(parseThemeMode("")).toBe("system");
    expect(parseThemeMode("DARK")).toBe("system");
    expect(parseThemeMode(1)).toBe("system");
    expect(parseThemeMode({ theme: "dark" })).toBe("system");
  });
});
