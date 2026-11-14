import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useInlineGroupEditing } from "@/components/config-editor/use-inline-group-editing";

type Item = { name: string };
type Group = { name: string; items: Item[] };

/** onChange 真实回写 value，模拟父组件受控更新，与编辑器内用法一致 */
function setup(initial: Group[]) {
  let latest: Group[] = initial;
  const view = renderHook(
    ({ value }: { value: Group[] }) =>
      useInlineGroupEditing<Group, Item>({
        value,
        onChange: (next) => {
          latest = next;
          view.rerender({ value: next });
        },
        cloneItem: (item) => ({ ...item }),
      }),
    { initialProps: { value: initial } },
  );
  return { ...view, getLatest: () => latest };
}

describe("useInlineGroupEditing", () => {
  it("编辑条目并应用后写回对应分组", () => {
    const { result, getLatest } = setup([
      { name: "A", items: [{ name: "a1" }, { name: "a2" }] },
    ]);

    act(() => result.current.openItemEdit(0, 1));
    expect(result.current.activeItemEdit?.draft).toEqual({ name: "a2" });

    act(() => result.current.updateItemDraft({ name: "a2x" }));
    act(() => result.current.applyItemEdit());

    expect(getLatest()).toEqual([
      { name: "A", items: [{ name: "a1" }, { name: "a2x" }] },
    ]);
    expect(result.current.activeItemEdit).toBeNull();
  });

  it("再次点击同一行编辑会收起", () => {
    const { result } = setup([{ name: "A", items: [{ name: "a1" }] }]);

    act(() => result.current.openItemEdit(0, 0));
    act(() => result.current.openItemEdit(0, 0));
    expect(result.current.activeItemEdit).toBeNull();
  });

  it("分组内条目重排会关闭该分组的行内编辑", () => {
    const { result } = setup([
      { name: "A", items: [{ name: "a1" }, { name: "a2" }] },
      { name: "B", items: [] },
    ]);

    act(() => result.current.openItemEdit(0, 0));
    act(() => result.current.replaceItems(0, [{ name: "a2" }, { name: "a1" }]));
    expect(result.current.activeItemEdit).toBeNull();
  });

  it("分组换位后所有下标偏移，行内编辑一并关闭", () => {
    const initial: Group[] = [
      { name: "A", items: [{ name: "a1" }] },
      { name: "B", items: [{ name: "b1" }] },
    ];
    const { result } = setup(initial);

    act(() => result.current.openItemEdit(1, 0));
    act(() => result.current.reorderGroups([initial[1]!, initial[0]!]));
    expect(result.current.activeItemEdit).toBeNull();
  });

  it("分组改名应用后写回", () => {
    const { result, getLatest } = setup([{ name: "A", items: [] }]);

    act(() => result.current.openGroupEdit(0));
    act(() => result.current.updateGroupName("A2"));
    act(() => result.current.applyGroupEdit());

    expect(getLatest()).toEqual([{ name: "A2", items: [] }]);
    expect(result.current.activeGroupEdit).toBeNull();
  });

  it("追加条目并立即进入其编辑态", () => {
    const { result, getLatest } = setup([
      { name: "A", items: [{ name: "a1" }] },
    ]);

    act(() => result.current.addItemAndEdit(0, { name: "a2" }));

    expect(getLatest()).toEqual([
      { name: "A", items: [{ name: "a1" }, { name: "a2" }] },
    ]);
    expect(result.current.activeItemEdit?.ii).toBe(1);
    expect(result.current.activeItemEdit?.draft).toEqual({ name: "a2" });
  });
});
