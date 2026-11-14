import { useState } from "react";

export type ItemEdit<TItem> = { gi: number; ii: number; draft: TItem };

export type GroupEdit = { gi: number; name: string };

/**
 * 服务/书签编辑器共用的行内编辑状态机：
 * 分组改名与条目编辑在列表内展开，不再弹二级对话框。
 * 行内下标在删除/拖拽后会失效，所有变更入口都会先关掉受影响的编辑态。
 */
export function useInlineGroupEditing<
  TGroup extends { name: string; items: TItem[] },
  TItem,
>({
  value,
  onChange,
  cloneItem,
}: {
  value: TGroup[];
  onChange: (next: TGroup[]) => void;
  cloneItem: (item: TItem) => TItem;
}) {
  const [itemEdit, setItemEdit] = useState<ItemEdit<TItem> | null>(null);
  const [groupEdit, setGroupEdit] = useState<GroupEdit | null>(null);

  // 编辑持有的下标在删除/拖拽后会失效，目标不存在时视为已关闭
  const activeItemEdit =
    itemEdit !== null && value[itemEdit.gi]?.items[itemEdit.ii]
      ? itemEdit
      : null;
  const activeGroupEdit =
    groupEdit !== null && value[groupEdit.gi] ? groupEdit : null;

  const closeItemEdit = (): void => setItemEdit(null);
  const closeGroupEdit = (): void => setGroupEdit(null);
  const closeAllEdits = (): void => {
    setItemEdit(null);
    setGroupEdit(null);
  };

  const openItemEdit = (gi: number, ii: number): void => {
    const item = value[gi]?.items[ii];
    if (!item) return;
    if (itemEdit?.gi === gi && itemEdit?.ii === ii) {
      setItemEdit(null);
      return;
    }
    setGroupEdit(null);
    setItemEdit({ gi, ii, draft: cloneItem(item) });
  };

  const updateItemDraft = (draft: TItem): void => {
    setItemEdit((prev) => (prev === null ? prev : { ...prev, draft }));
  };

  const applyItemEdit = (): void => {
    if (activeItemEdit === null) return;
    const { gi, ii, draft } = activeItemEdit;
    onChange(
      value.map((g, i) =>
        i === gi
          ? {
              ...g,
              items: g.items.map((it, idx) => (idx === ii ? draft : it)),
            }
          : g,
      ),
    );
    setItemEdit(null);
  };

  const openGroupEdit = (gi: number): void => {
    const group = value[gi];
    if (!group) return;
    if (groupEdit?.gi === gi) {
      setGroupEdit(null);
      return;
    }
    setItemEdit(null);
    setGroupEdit({ gi, name: group.name });
  };

  const updateGroupName = (name: string): void => {
    setGroupEdit((prev) => (prev !== null ? { ...prev, name } : prev));
  };

  const applyGroupEdit = (): void => {
    if (activeGroupEdit === null) return;
    const { gi, name } = activeGroupEdit;
    onChange(value.map((g, i) => (i === gi ? { ...g, name } : g)));
    setGroupEdit(null);
  };

  /** 分组换位后所有下标偏移，行内编辑一并关闭 */
  const reorderGroups = (next: TGroup[]): void => {
    closeAllEdits();
    onChange(next);
  };

  const deleteGroup = (gi: number): void => {
    closeAllEdits();
    onChange(value.filter((_, i) => i !== gi));
  };

  const replaceItems = (gi: number, items: TItem[]): void => {
    if (itemEdit?.gi === gi) setItemEdit(null);
    onChange(value.map((g, i) => (i === gi ? { ...g, items } : g)));
  };

  const deleteItem = (gi: number, ii: number): void => {
    if (itemEdit?.gi === gi) setItemEdit(null);
    onChange(
      value.map((g, i) =>
        i === gi
          ? { ...g, items: g.items.filter((_, idx) => idx !== ii) }
          : g,
      ),
    );
  };

  /** 追加新条目并立即进入其行内编辑 */
  const addItemAndEdit = (gi: number, item: TItem): void => {
    const group = value[gi];
    if (!group) return;
    const nextItems = [...group.items, item];
    setGroupEdit(null);
    setItemEdit({ gi, ii: nextItems.length - 1, draft: cloneItem(item) });
    onChange(value.map((g, i) => (i === gi ? { ...g, items: nextItems } : g)));
  };

  return {
    activeItemEdit,
    activeGroupEdit,
    openItemEdit,
    closeItemEdit,
    updateItemDraft,
    applyItemEdit,
    openGroupEdit,
    updateGroupName,
    applyGroupEdit,
    closeGroupEdit,
    closeAllEdits,
    reorderGroups,
    deleteGroup,
    replaceItems,
    deleteItem,
    addItemAndEdit,
  };
}
