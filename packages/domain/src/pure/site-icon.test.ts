import { describe, expect, it } from "vitest";

import { isSameOrigin } from "./site-icon.js";

describe("isSameOrigin", () => {
  it("同 host 不同端口判定为不同源", () => {
    expect(
      isSameOrigin("http://example.com/a", "http://example.com:2375/b"),
    ).toBe(false);
  });

  it("同 host 不同协议判定为不同源", () => {
    expect(
      isSameOrigin("https://example.com/a", "http://example.com/a"),
    ).toBe(false);
  });

  it("默认端口与显式端口等价", () => {
    expect(isSameOrigin("http://example.com/a", "http://example.com:80/b")).toBe(
      true,
    );
    expect(
      isSameOrigin("https://example.com/a", "https://example.com:443/b"),
    ).toBe(true);
  });

  it("hostname 大小写不敏感", () => {
    expect(isSameOrigin("http://Example.COM/x", "http://example.com/y")).toBe(
      true,
    );
  });
});
