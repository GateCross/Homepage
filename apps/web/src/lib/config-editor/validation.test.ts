import { describe, expect, it } from "vitest";

import type { EditableConfig, EditableConfigWrite } from "@/lib/contracts";

import {
  editableViewToDefaultWrite,
  moveItem,
  prepareDraftForSave,
  resolveDocumentTitle,
  validateEditableDraft,
} from "./validation";

/** 最小合法草稿，各用例在此基础上改单点 */
function emptyDraft(): EditableConfigWrite {
  return {
    settings: { title: "首页", useEqualHeights: false, layout: [] },
    services: [],
    bookmarks: [],
    infoWidgets: [],
    dockerEndpoints: [],
  };
}

/** 最小可编辑视图，用于验证默认写回载荷的密钥三态 */
function emptyView(): EditableConfig {
  return {
    settings: { title: "首页", useEqualHeights: false, layout: [] },
    services: [],
    bookmarks: [],
    infoWidgets: [],
    dockerEndpoints: [],
  };
}

describe("validateEditableDraft", () => {
  it("空草稿校验通过", () => {
    expect(validateEditableDraft(emptyDraft())).toBeNull();
  });

  it("服务分组与条目名为空时各报一条", () => {
    const draft = emptyDraft();
    draft.services = [
      { name: "  ", items: [{ name: "" }] },
    ];

    const errors = validateEditableDraft(draft);
    expect(errors).not.toBeNull();
    expect(errors?.["services.0.name"]).toBe("名称不能为空");
    expect(errors?.["services.0.items.0.name"]).toBe("名称不能为空");
  });

  it("服务条目 href 非空但非 HTTP 时拒绝，为空时放行", () => {
    const ok = emptyDraft();
    ok.services = [{ name: "组", items: [{ name: "无链接" }] }];
    expect(validateEditableDraft(ok)).toBeNull();

    const bad = emptyDraft();
    bad.services = [{ name: "组", items: [{ name: "坏链接", href: "ftp://x" }] }];
    expect(validateEditableDraft(bad)?.["services.0.items.0.href"]).toBe(
      "须为绝对 HTTP 或 HTTPS 链接",
    );
  });

  it("服务组件 url 可选，缺省不报错，给了非法值才拒绝", () => {
    // 与后端保持一致：payload.go 的 stringField("url", false) 允许省略
    const absent = emptyDraft();
    absent.services = [
      { name: "组", items: [{ name: "组件", widget: { type: "qbittorrent" } }] },
    ];
    expect(validateEditableDraft(absent)).toBeNull();

    const bad = emptyDraft();
    bad.services = [
      {
        name: "组",
        items: [
          { name: "组件", widget: { type: "emby", url: "不是链接" } },
        ],
      },
    ];
    expect(validateEditableDraft(bad)?.["services.0.items.0.widget.url"]).toBe(
      "须为绝对 HTTP 或 HTTPS 链接",
    );
  });

  it("探测 url 只在启用且已填时校验", () => {
    const disabled = emptyDraft();
    disabled.services = [
      {
        name: "组",
        items: [
          { name: "关", httpProbe: { enabled: false, url: "不是链接" } },
        ],
      },
    ];
    expect(validateEditableDraft(disabled)).toBeNull();

    const enabled = emptyDraft();
    enabled.services = [
      {
        name: "组",
        items: [{ name: "开", httpProbe: { enabled: true, url: "不是链接" } }],
      },
    ];
    expect(
      validateEditableDraft(enabled)?.["services.0.items.0.httpProbe.url"],
    ).toBe("须为绝对 HTTP 或 HTTPS 链接");
  });

  it("书签 href 为必填", () => {
    const draft = emptyDraft();
    draft.bookmarks = [{ name: "组", items: [{ name: "书签", href: "" }] }];
    expect(validateEditableDraft(draft)?.["bookmarks.0.items.0.href"]).toBe(
      "链接不能为空",
    );
  });

  it("天气组件校验城市编码与地点名", () => {
    const badCity = emptyDraft();
    badCity.infoWidgets = [
      { type: "openmeteo", cityId: "abc", location: "上海" },
    ];
    expect(validateEditableDraft(badCity)?.["infoWidgets.0"]).toContain(
      "城市编码",
    );

    const noLocation = emptyDraft();
    noLocation.infoWidgets = [
      { type: "openmeteo", cityId: "101020100", location: "  " },
    ];
    expect(validateEditableDraft(noLocation)?.["infoWidgets.0"]).toContain(
      "地点名称",
    );

    const ok = emptyDraft();
    ok.infoWidgets = [
      { type: "openmeteo", cityId: "101020100", location: "上海" },
    ];
    expect(validateEditableDraft(ok)).toBeNull();
  });

  it("天气城市编码接受 weathercn: 前缀", () => {
    const draft = emptyDraft();
    draft.infoWidgets = [
      { type: "openmeteo", cityId: "weathercn:101020100", location: "上海" },
    ];
    expect(validateEditableDraft(draft)).toBeNull();
  });

  it("Docker 连接串：空、带 userinfo、格式不支持各报不同文案", () => {
    const empty = emptyDraft();
    empty.dockerEndpoints = [{ name: "本机", connection: "  " }];
    expect(validateEditableDraft(empty)?.["dockerEndpoints.0.connection"]).toBe(
      "连接串不能为空",
    );

    const userinfo = emptyDraft();
    userinfo.dockerEndpoints = [
      { name: "本机", connection: "tcp://user:pass@10.0.0.1:2375" },
    ];
    expect(
      validateEditableDraft(userinfo)?.["dockerEndpoints.0.connection"],
    ).toContain("不得包含用户名或密码");

    const unsupported = emptyDraft();
    unsupported.dockerEndpoints = [
      { name: "本机", connection: "http://10.0.0.1:2375" },
    ];
    expect(
      validateEditableDraft(unsupported)?.["dockerEndpoints.0.connection"],
    ).toBe("连接串须为 unix:///path 或 tcp://host:port 形式");
  });

  it("Docker 连接串合法形态通过校验", () => {
    const unix = emptyDraft();
    unix.dockerEndpoints = [{ name: "本机", connection: "unix:///var/run/docker.sock" }];
    expect(validateEditableDraft(unix)).toBeNull();

    const tcp = emptyDraft();
    tcp.dockerEndpoints = [{ name: "远端", connection: "tcp://10.0.0.1:2375" }];
    expect(validateEditableDraft(tcp)).toBeNull();
  });

  it("Docker 连接串 userinfo 判定不回显原串", () => {
    const draft = emptyDraft();
    draft.dockerEndpoints = [
      { name: "本机", connection: "tcp://admin:hunter2@10.0.0.1:2375" },
    ];
    const message = validateEditableDraft(draft)?.["dockerEndpoints.0.connection"];
    expect(message).toBeDefined();
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("admin");
  });

  it("多条错误同时返回，键为字段路径", () => {
    const draft = emptyDraft();
    draft.services = [{ name: "", items: [{ name: "" }] }];
    draft.bookmarks = [{ name: "", items: [{ name: "书签", href: "" }] }];

    const errors = validateEditableDraft(draft);
    expect(Object.keys(errors ?? {}).sort()).toEqual([
      "bookmarks.0.items.0.href",
      "bookmarks.0.name",
      "services.0.items.0.name",
      "services.0.name",
    ]);
  });
});

describe("prepareDraftForSave", () => {
  function resourcesDraft(
    disk: string | Array<string | { path: string; label?: string }>,
  ): EditableConfigWrite {
    const draft = emptyDraft();
    draft.infoWidgets = [{ type: "resources", disk }];
    return draft;
  }

  it("单条字符串保持字符串形态", () => {
    const out = prepareDraftForSave(resourcesDraft("/data"));
    const widget = out.infoWidgets[0];
    expect(widget?.type === "resources" ? widget.disk : undefined).toBe("/data");
  });

  it("逗号分隔的多条拆成数组", () => {
    const out = prepareDraftForSave(resourcesDraft("/data, /mnt"));
    const widget = out.infoWidgets[0];
    const disk = widget?.type === "resources" ? widget.disk : undefined;
    expect(disk).toEqual(["/data", "/mnt"]);
  });

  it("中文逗号同样分隔", () => {
    const out = prepareDraftForSave(resourcesDraft("/data，/mnt"));
    const widget = out.infoWidgets[0];
    const disk = widget?.type === "resources" ? widget.disk : undefined;
    expect(disk).toEqual(["/data", "/mnt"]);
  });

  it("管道符写法解析出别名", () => {
    const out = prepareDraftForSave(resourcesDraft("/data|数据盘"));
    const widget = out.infoWidgets[0];
    const disk = widget?.type === "resources" ? widget.disk : undefined;
    expect(disk).toEqual([{ path: "/data", label: "数据盘" }]);
  });

  it("半角与全角冒号写法解析出别名", () => {
    for (const raw of ["/data: 数据盘", "/data：数据盘"]) {
      const out = prepareDraftForSave(resourcesDraft(raw));
      const widget = out.infoWidgets[0];
      const disk = widget?.type === "resources" ? widget.disk : undefined;
      expect(disk).toEqual([{ path: "/data", label: "数据盘" }]);
    }
  });

  it("盘符写法不被当成别名分隔", () => {
    const out = prepareDraftForSave(resourcesDraft("C:/data"));
    const widget = out.infoWidgets[0];
    const disk = widget?.type === "resources" ? widget.disk : undefined;
    expect(disk).toBe("C:/data");
  });

  it("已归一的对象数组保留 label", () => {
    const out = prepareDraftForSave(
      resourcesDraft([{ path: "/data", label: "数据盘" }]),
    );
    const widget = out.infoWidgets[0];
    const disk = widget?.type === "resources" ? widget.disk : undefined;
    expect(disk).toEqual([{ path: "/data", label: "数据盘" }]);
  });

  it("空磁盘值整个字段被移除，不写空串", () => {
    const out = prepareDraftForSave(resourcesDraft("   "));
    const widget = out.infoWidgets[0];
    expect(widget?.type === "resources" && "disk" in widget).toBe(false);
  });

  it("非资源组件原样返回", () => {
    const draft = emptyDraft();
    draft.infoWidgets = [
      { type: "openmeteo", cityId: "101020100", location: "上海" },
    ];
    const out = prepareDraftForSave(draft);
    expect(out.infoWidgets[0]).toEqual({
      type: "openmeteo",
      cityId: "101020100",
      location: "上海",
    });
  });
});

describe("editableViewToDefaultWrite", () => {
  it("已配置的密钥转成 keep，unset 不写入", () => {
    const view = emptyView();
    view.services = [
      {
        name: "组",
        items: [
          {
            name: "Emby",
            widget: {
              type: "emby",
              url: "https://emby.local",
              apiKey: { status: "configured" },
              token: { status: "unset" },
            },
          },
        ],
      },
    ];

    const write = editableViewToDefaultWrite(view);
    const widget = write.services[0]?.items[0]?.widget;
    expect(widget?.apiKey).toEqual({ mode: "keep" });
    expect(widget?.token).toBeUndefined();
  });

  it("自定义请求头的密钥缺失时按 keep 兜底", () => {
    const view = emptyView();
    view.services = [
      {
        name: "组",
        items: [
          {
            name: "Custom",
            widget: {
              type: "customapi",
              url: "https://api.local",
              headers: [{ name: "X-Key" } as { name: string; value: never }],
            },
          },
        ],
      },
    ];

    const write = editableViewToDefaultWrite(view);
    expect(write.services[0]?.items[0]?.widget?.headers?.[0]?.value).toEqual({
      mode: "keep",
    });
  });

  it("可选字段缺省时不写入，避免空的 undefined 键", () => {
    const view = emptyView();
    view.services = [
      { name: "组", items: [{ name: "朴素" }] },
    ];

    const write = editableViewToDefaultWrite(view);
    const item = write.services[0]?.items[0];
    expect(item).toEqual({ name: "朴素" });
    expect("href" in (item ?? {})).toBe(false);
  });

  it("设置段的可选字段同样按存在性拷贝", () => {
    const view = emptyView();
    view.settings.background = "/images/bg.jpg";
    const write = editableViewToDefaultWrite(view);
    expect(write.settings.background).toBe("/images/bg.jpg");
    expect("favicon" in write.settings).toBe(false);
  });

  it("布局与书签做浅拷贝，不与视图共享引用", () => {
    const view = emptyView();
    view.settings.layout = [{ groupName: "Server", maxColumns: 4 }];
    view.bookmarks = [{ name: "组", items: [{ name: "B", href: "https://b" }] }];

    const write = editableViewToDefaultWrite(view);
    expect(write.settings.layout[0]).toEqual({
      groupName: "Server",
      maxColumns: 4,
    });
    expect(write.settings.layout[0]).not.toBe(view.settings.layout[0]);
    expect(write.bookmarks[0]?.items[0]).not.toBe(view.bookmarks[0]?.items[0]);
  });
});

describe("moveItem", () => {
  it("把元素从 from 移到 to", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("索引相同或越界时原样返回同一引用", () => {
    const list = ["a", "b"];
    expect(moveItem(list, 1, 1)).toBe(list);
    expect(moveItem(list, -1, 0)).toBe(list);
    expect(moveItem(list, 0, 5)).toBe(list);
  });

  it("返回新数组，不修改入参", () => {
    const list = ["a", "b", "c"];
    const out = moveItem(list, 0, 1);
    expect(out).not.toBe(list);
    expect(list).toEqual(["a", "b", "c"]);
  });
});

describe("resolveDocumentTitle", () => {
  it("空标题回落到默认标题", () => {
    expect(resolveDocumentTitle("")).toBe("首页");
    expect(resolveDocumentTitle("   ")).toBe("首页");
    expect(resolveDocumentTitle(undefined)).toBe("首页");
  });

  it("标题去空白后原样返回", () => {
    expect(resolveDocumentTitle("  我的首页  ")).toBe("我的首页");
  });
});
