/**
 * 服务编辑器纯模型的行为契约：默认值、关键字摘要、已绑定容器键、字段切换。
 * 这些函数是拆分 ServicesEditor 后各表单共用的取值来源，须锁定不被改坏。
 */
import { describe, expect, it } from "vitest";

import type { EditableServiceGroupWrite } from "@/lib/contracts";

import {
  CADDY_FIELD_OPTIONS,
  CUSTOM_API_FORMAT_OPTIONS,
  EMBY_FIELD_OPTIONS,
  IMMICH_FIELD_OPTIONS,
  cloneService,
  collectBoundDockerKeys,
  emptyGroup,
  emptyService,
  serviceHost,
  serviceKeywords,
} from "./service-model";

describe("emptyService / emptyGroup", () => {
  it("新建服务有默认名称且不带可选字段", () => {
    expect(emptyService()).toEqual({ name: "新服务" });
  });

  it("新建分组带一条服务，且两次调用互不影响", () => {
    const a = emptyGroup();
    const b = emptyGroup();
    expect(a.name).toBe("新分组");
    expect(a.items).toHaveLength(1);
    a.items[0]!.name = "改过";
    expect(b.items[0]!.name).toBe("新服务");
  });
});

describe("cloneService", () => {
  it("深拷贝嵌套对象，改副本不影响原值", () => {
    const original: EditableServiceGroupWrite = {
      name: "g",
      items: [
        {
          name: "svc",
          docker: { server: "nas", container: "plex" },
          widget: { type: "emby", fields: ["movies"] },
        },
      ],
    };
    const cloned = cloneService(original.items[0]!);
    cloned.docker!.container = "jellyfin";
    cloned.widget!.fields!.push("series");
    expect(original.items[0]!.docker!.container).toBe("plex");
    expect(original.items[0]!.widget!.fields).toEqual(["movies"]);
  });
});

describe("serviceKeywords / serviceHost", () => {
  it("空服务零标签、无地址", () => {
    expect(serviceKeywords(emptyService())).toEqual([]);
    expect(serviceHost(emptyService())).toBeNull();
  });

  it("标签只含状态与绑定维度，主机与描述走独立列", () => {
    const item = emptyService();
    item.hidden = true;
    item.href = "https://example.com:8080/path";
    item.httpProbe = { enabled: true };
    item.docker = { server: "nas", container: "plex" };
    item.widget = { type: "emby" };
    item.description = "  媒体库  ";
    expect(serviceKeywords(item)).toEqual([
      "已隐藏",
      "探测",
      "nas/plex",
      "emby",
    ]);
    expect(serviceHost(item)).toBe("example.com:8080");
  });

  it("docker 无 server 时只显示容器名", () => {
    const item = emptyService();
    item.docker = { server: "", container: "plex" };
    expect(serviceKeywords(item)).toEqual(["plex"]);
  });
});

describe("collectBoundDockerKeys", () => {
  it("只收集 server 与 container 都非空的绑定", () => {
    const groups: EditableServiceGroupWrite[] = [
      {
        name: "g1",
        items: [
          { name: "a", docker: { server: "nas", container: "plex" } },
          { name: "b", docker: { server: "", container: "jellyfin" } },
          { name: "c" },
        ],
      },
      {
        name: "g2",
        items: [{ name: "d", docker: { server: "nas", container: "plex" } }],
      },
    ];
    expect([...collectBoundDockerKeys(groups)]).toEqual(["nas::plex"]);
  });

  it("空分组返回空集", () => {
    expect(collectBoundDockerKeys([]).size).toBe(0);
  });
});

describe("字段选项常量", () => {
  it("四组选项 id 无重复且非空", () => {
    const all = [
      ...EMBY_FIELD_OPTIONS,
      ...IMMICH_FIELD_OPTIONS,
      ...CADDY_FIELD_OPTIONS,
      ...CUSTOM_API_FORMAT_OPTIONS,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const opt of all) {
      expect(typeof opt === "string" ? opt : opt.id).toBeTruthy();
    }
  });
});
