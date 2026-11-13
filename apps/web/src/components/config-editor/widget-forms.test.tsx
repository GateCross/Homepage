/**
 * 组件选项表单的行为契约：字段切换三态与按类型分发。
 * 拆分 ServicesEditor 后这些表单共用同一套字段网格，须锁定语义。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EditableServiceWidgetWrite } from "@/lib/contracts";

import { toggleFieldList, WidgetOptionsForm } from "./widget-forms";

const options = [
  { id: "a", label: "甲" },
  { id: "b", label: "乙" },
  { id: "c", label: "丙" },
];

describe("toggleFieldList", () => {
  it("空列表视为全选，取消一项后保留其余", () => {
    expect(toggleFieldList(options, [], "b", false)).toEqual(["a", "c"]);
  });

  it("空列表下若切换结果仍是全选则返回 undefined", () => {
    expect(toggleFieldList(options, [], "b", true)).toBeUndefined();
  });

  it("部分选中时新增一项", () => {
    expect(toggleFieldList(options, ["a"], "b", true)).toEqual(["a", "b"]);
  });

  it("切到全空或全满都归一化为 undefined", () => {
    expect(toggleFieldList(options, ["a"], "a", false)).toBeUndefined();
    expect(toggleFieldList(options, ["a", "b"], "c", true)).toBeUndefined();
  });

  it("不在选项表里的 id 不改变当前集合", () => {
    expect(toggleFieldList(options, ["a"], "z", true)).toEqual(["a"]);
  });
});

const base = (type: string): EditableServiceWidgetWrite => ({
  type,
  url: "http://127.0.0.1",
});

describe("WidgetOptionsForm 分发", () => {
  it("emby 显示专属标题", () => {
    render(<WidgetOptionsForm widget={base("emby")} onChange={vi.fn()} />);
    expect(screen.getByText("Emby 展示选项")).toBeTruthy();
  });

  it("immich 显示专属标题", () => {
    render(<WidgetOptionsForm widget={base("immich")} onChange={vi.fn()} />);
    expect(screen.getByText("Immich 选项")).toBeTruthy();
  });

  it("caddy 显示专属标题", () => {
    render(<WidgetOptionsForm widget={base("caddy")} onChange={vi.fn()} />);
    expect(screen.getByText("Caddy 选项")).toBeTruthy();
  });

  it("customapi 显示专属标题", () => {
    render(<WidgetOptionsForm widget={base("customapi")} onChange={vi.fn()} />);
    expect(screen.getByText("Custom API 选项")).toBeTruthy();
  });

  it("未知类型不渲染任何选项", () => {
    const { container } = render(
      <WidgetOptionsForm widget={base("qbittorrent")} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("字段网格全展示语义", () => {
  it("空 fields 时所有复选框均为选中", () => {
    render(
      <WidgetOptionsForm widget={base("immich")} onChange={vi.fn()} />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(1);
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it("白名单只勾选指定项，取消后回调写回剩余集合", () => {
    const onChange = vi.fn();
    render(
      <WidgetOptionsForm
        widget={{ ...base("immich"), fields: ["users"] }}
        onChange={onChange}
      />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.filter((b) => b.checked)).toHaveLength(1);
    // 再取消已勾选那一项：切到全空应回传 undefined
    boxes.find((b) => b.checked)!.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].fields).toBeUndefined();
  });
});
