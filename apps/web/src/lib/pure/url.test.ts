import { describe, expect, it } from "vitest";

import { isAbsoluteHttpUrl, normalizeAbsoluteHttpUrl } from "./url";

describe("normalizeAbsoluteHttpUrl", () => {
  it("补全空路径为 /", () => {
    expect(normalizeAbsoluteHttpUrl("https://example.com")).toBe(
      "https://example.com/",
    );
  });

  it("剥离 hash 但保留 query", () => {
    expect(
      normalizeAbsoluteHttpUrl("https://example.com/a?x=1#section"),
    ).toBe("https://example.com/a?x=1");
  });

  it("剥离 userinfo", () => {
    expect(
      normalizeAbsoluteHttpUrl("https://user:pass@example.com/path"),
    ).toBe("https://example.com/path");
  });

  it("省略默认端口、保留非默认端口", () => {
    expect(normalizeAbsoluteHttpUrl("https://example.com:443/a")).toBe(
      "https://example.com/a",
    );
    expect(normalizeAbsoluteHttpUrl("http://example.com:80/a")).toBe(
      "http://example.com/a",
    );
    expect(normalizeAbsoluteHttpUrl("http://example.com:8080/a")).toBe(
      "http://example.com:8080/a",
    );
  });

  it("hostname 统一小写", () => {
    expect(normalizeAbsoluteHttpUrl("https://Example.COM/A")).toBe(
      "https://example.com/A",
    );
  });

  it("非 http(s) 与非法串返回 null", () => {
    expect(normalizeAbsoluteHttpUrl("ftp://example.com")).toBeNull();
    expect(normalizeAbsoluteHttpUrl("//example.com/a")).toBeNull();
    expect(normalizeAbsoluteHttpUrl("/relative")).toBeNull();
    expect(normalizeAbsoluteHttpUrl("")).toBeNull();
    expect(normalizeAbsoluteHttpUrl("   ")).toBeNull();
    expect(normalizeAbsoluteHttpUrl("not a url")).toBeNull();
  });

  it("同一链接的不同写法得到同一身份串", () => {
    const a = normalizeAbsoluteHttpUrl("HTTPS://User@Example.com:443");
    const b = normalizeAbsoluteHttpUrl("https://example.com/");
    expect(a).toBe(b);
  });
});

describe("isAbsoluteHttpUrl", () => {
  it("只认绝对 http(s) 链接", () => {
    expect(isAbsoluteHttpUrl("https://example.com")).toBe(true);
    expect(isAbsoluteHttpUrl("http://127.0.0.1:8080/x")).toBe(true);
    expect(isAbsoluteHttpUrl("/images/a.png")).toBe(false);
    expect(isAbsoluteHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isAbsoluteHttpUrl("")).toBe(false);
  });
});
