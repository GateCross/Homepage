import { describe, expect, it } from "vitest";

import { resolveSafeHref } from "@/lib/safe-link";

// 契约对齐回归：后端 normalizeTarget 接受四种窗口目标，
// 前端不得再把 _parent / _top 判成 unsafe_target 使条目不可点击。
describe("resolveSafeHref 窗口目标契约", () => {
  it("四种目标全部放行", () => {
    for (const target of ["_blank", "_self", "_parent", "_top"]) {
      const resolved = resolveSafeHref("https://example.com", target);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.target).toBe(target);
      }
    }
  });

  it("仅 _blank 附带 noopener rel", () => {
    const blank = resolveSafeHref("https://example.com", "_blank");
    const self = resolveSafeHref("https://example.com", "_self");
    expect(blank.ok && blank.rel).toBe("noopener noreferrer");
    expect(self.ok && self.rel).toBeUndefined();
  });

  it("目标缺省回落 _blank，未知目标拒绝", () => {
    const defaulted = resolveSafeHref("https://example.com", "");
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.target).toBe("_blank");
    }
    expect(resolveSafeHref("https://example.com", "_new")).toEqual({
      ok: false,
      reason: "unsafe_target",
    });
  });
});
