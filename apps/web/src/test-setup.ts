import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// 未开启 globals 时 testing-library 不会自动注册清理，需在每次用例后显式卸载。
afterEach(() => {
  cleanup();
});
