import { describe, expect, it } from "vitest";

import { AdapterLocalError } from "./http.js";
import { convertImmichStatistics } from "./immich.js";

describe("convertImmichStatistics", () => {
  it("空对象全部缺失时抛出无效字段错误", () => {
    expect(() => convertImmichStatistics({})).toThrow(AdapterLocalError);
    expect(() => convertImmichStatistics({})).toThrow(/缺少有效字段/);
  });

  it("部分字段缺失时缺失项标记 unavailable 且不填假成功零值为主状态", () => {
    const metrics = convertImmichStatistics({ photos: 12 });
    const photos = metrics.find((m) => m.id === "photos");
    const users = metrics.find((m) => m.id === "users");
    expect(photos?.value).toBe(12);
    expect(photos?.status).toBe("ok");
    expect(users?.status).toBe("unavailable");
  });

  it("全部可解析字段存在时均为 ok", () => {
    const metrics = convertImmichStatistics({
      users: 2,
      photos: 10,
      videos: 3,
      usage: 1024,
    });
    expect(metrics.every((m) => m.status === "ok")).toBe(true);
  });
});
