import { describe, expect, it } from "vitest";

import { parseErrorEnvelope, parseApiSuccess } from "./api";

describe("parseApiSuccess", () => {
  it("校验顶层字段存在且类型正确", () => {
    const config = {
      settings: { title: "首页" },
      services: [],
      bookmarks: [],
      infoWidgets: [],
    };
    expect(parseApiSuccess("config", config)).toBe(config);
  });

  it("缺字段时抛错，交由 client 包成 invalid_response", () => {
    expect(() =>
      parseApiSuccess("config", { settings: {}, services: [] }),
    ).toThrow(/bookmarks/);
  });

  it("要求 ok=true 的路由拒绝 ok=false", () => {
    expect(() => parseApiSuccess("version", { ok: false, version: "1" })).toThrow(
      /ok=true/,
    );
  });

  it("非对象响应体直接拒绝", () => {
    expect(() => parseApiSuccess("config", null)).toThrow(/不是对象/);
    expect(() => parseApiSuccess("config", [])).toThrow(/不是对象/);
    expect(() => parseApiSuccess("config", "text")).toThrow(/不是对象/);
  });

  it("字段类型不符时报错", () => {
    expect(() =>
      parseApiSuccess("version", { ok: true, version: 1, updateAvailable: false }),
    ).toThrow(/version/);
  });
});

describe("parseErrorEnvelope", () => {
  it("解析标准错误信封", () => {
    expect(
      parseErrorEnvelope({
        ok: false,
        error: { message: "配置无效", path: "settings.yaml", line: 3 },
      }),
    ).toEqual({
      ok: false,
      error: { message: "配置无效", path: "settings.yaml", line: 3 },
    });
  });

  it("丢弃类型不符的定位字段", () => {
    expect(
      parseErrorEnvelope({
        ok: false,
        error: { message: "错了", line: "3", column: -1, file: "" },
      }),
    ).toEqual({ ok: false, error: { message: "错了" } });
  });

  it("非错误信封返回 null", () => {
    expect(parseErrorEnvelope(null)).toBeNull();
    expect(parseErrorEnvelope({ ok: true })).toBeNull();
    expect(parseErrorEnvelope({ ok: false })).toBeNull();
    expect(parseErrorEnvelope({ ok: false, error: { message: "" } })).toBeNull();
    expect(parseErrorEnvelope("boom")).toBeNull();
  });
});
