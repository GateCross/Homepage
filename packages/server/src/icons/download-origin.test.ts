import { describe, expect, it } from "vitest";

import type { DiscoveredIconRef } from "@homepage/domain";

import { downloadCandidateBodies } from "./fetch.js";

describe("downloadCandidateBodies 同源过滤", () => {
  it("跳过与 sourceUrl 不同 origin 的候选，不发起下载", async () => {
    const calls: string[] = [];
    const refs: DiscoveredIconRef[] = [
      {
        href: "http://evil.example/icon.png",
        tier: "rel-icon",
      },
      {
        href: "http://good.example/favicon.ico",
        tier: "static-favicon",
      },
    ];

    const pngHeader = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3,
    ]);

    const out = await downloadCandidateBodies(refs, {
      sourceUrl: "http://good.example/page",
      requestImpl: async (url) => {
        calls.push(url);
        return {
          kind: "response",
          statusCode: 200,
          url,
          headers: { "content-type": "image/png" },
          body: pngHeader,
        };
      },
    });

    expect(calls).toEqual(["http://good.example/favicon.ico"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.ref.href).toBe("http://good.example/favicon.ico");
  });
});
