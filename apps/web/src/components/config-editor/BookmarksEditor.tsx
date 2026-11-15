import { useState, type JSX } from "react";

import type {
  EditableBookmarkGroup,
  EditableBookmarkItem,
} from "@/lib/contracts";

import {
  EditorGroupCard,
  EditorListRow,
  EditorPageHeader,
  useReorderDrag,
} from "@/components/config-editor/EditorListChrome";
import { AddGroupDialog } from "@/components/config-editor/AddGroupDialog";
import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
import {
  useInlineGroupEditing,
  type GroupEdit,
} from "@/components/config-editor/use-inline-group-editing";
import { BookmarkIconView } from "@/components/shared/ResolvedIconView";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  groupHasItemErrors,
  itemHasErrors,
  summarizeHref,
} from "@/lib/editor-paths";

export type BookmarksEditorProps = {
  value: EditableBookmarkGroup[];
  onChange: (next: EditableBookmarkGroup[]) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
};

function emptyItem(): EditableBookmarkItem {
  return { name: "新书签", href: "https://example.com" };
}

function emptyGroup(name = "新分组"): EditableBookmarkGroup {
  return { name, items: [emptyItem()] };
}

function cloneItem(item: EditableBookmarkItem): EditableBookmarkItem {
  return structuredClone(item);
}

function bookmarkTags(item: EditableBookmarkItem): string[] {
  const tags: string[] = [];
  if (item.abbr?.trim()) tags.push(item.abbr.trim());
  return tags;
}

function BookmarkItemForm({
  value,
  onChange,
  disabled,
  errorPrefix,
  errors,
}: {
  value: EditableBookmarkItem;
  onChange: (next: EditableBookmarkItem) => void;
  disabled?: boolean;
  errorPrefix: string;
  errors?: Record<string, string>;
}): JSX.Element {
  const patch = (partial: Partial<EditableBookmarkItem>): void => {
    onChange({ ...value, ...partial });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>名称</Label>
          <Input
            value={value.name}
            disabled={disabled}
            onChange={(e) => patch({ name: e.target.value })}
          />
          {errors?.[`${errorPrefix}.name`] ? (
            <p className="text-xs text-destructive">
              {errors[`${errorPrefix}.name`]}
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label>链接</Label>
          <Input
            value={value.href}
            disabled={disabled}
            onChange={(e) => patch({ href: e.target.value })}
          />
          {errors?.[`${errorPrefix}.href`] ? (
            <p className="text-xs text-destructive">
              {errors[`${errorPrefix}.href`]}
            </p>
          ) : null}
        </div>
        <ImageAssetField
          label="图标"
          value={value.icon ?? ""}
          {...(disabled !== undefined ? { disabled } : {})}
          preview="icon"
          placeholder="mdi-xxx / si-xxx / URL / /images/..."
          hint="支持图标名、URL、上传，或从链接获取站点图标（abbr 不参与图标显示）"
          siteIconSourceUrl={value.href}
          onChange={(next) =>
            patch({
              // 空串清除；undefined 会在 merge 时保留磁盘原值
              icon: next.trim(),
            })
          }
        />
        <div className="space-y-1">
          <Label>缩写</Label>
          <Input
            value={value.abbr ?? ""}
            disabled={disabled}
            onChange={(e) =>
              patch({
                // 空串清除；undefined 会在 merge 时保留磁盘原值
                abbr: e.target.value,
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            保留字段；不再用作图标回退
          </p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label>描述</Label>
          <Input
            value={value.description ?? ""}
            disabled={disabled}
            onChange={(e) =>
              patch({
                // 空串表示清除；undefined 会在 merge 时保留磁盘原值
                description: e.target.value,
              })
            }
          />
        </div>
      </div>
    </div>
  );
}

function BookmarkGroupBlock({
  group,
  gi,
  disabled,
  errors,
  dragHandleProps,
  rowProps,
  editingItemIndex,
  groupEdit,
  onOpenItemEdit,
  onOpenGroupEdit,
  onGroupNameChange,
  onApplyGroupEdit,
  onCancelGroupEdit,
  onDeleteGroup,
  onMoveGroupUp,
  onMoveGroupDown,
  canMoveGroupUp,
  canMoveGroupDown,
  onAddItem,
  onReorderItems,
  onDeleteItem,
  onMoveItemUp,
  onMoveItemDown,
}: {
  group: EditableBookmarkGroup;
  gi: number;
  disabled?: boolean | undefined;
  errors?: Record<string, string> | undefined;
  dragHandleProps: ReturnType<
    ReturnType<typeof useReorderDrag>["getHandleProps"]
  >;
  rowProps: ReturnType<ReturnType<typeof useReorderDrag>["getRowProps"]>;
  /** 正在编辑的条目下标（弹窗打开时对应卡片描边） */
  editingItemIndex: number | null;
  groupEdit: GroupEdit | null;
  onOpenItemEdit: (ii: number) => void;
  onOpenGroupEdit: () => void;
  onGroupNameChange: (name: string) => void;
  onApplyGroupEdit: () => void;
  onCancelGroupEdit: () => void;
  onDeleteGroup: () => void;
  onMoveGroupUp: () => void;
  onMoveGroupDown: () => void;
  canMoveGroupUp: boolean;
  canMoveGroupDown: boolean;
  onAddItem: () => void;
  onReorderItems: (items: EditableBookmarkItem[]) => void;
  onDeleteItem: (ii: number) => void;
  onMoveItemUp: (ii: number) => void;
  onMoveItemDown: (ii: number) => void;
}): JSX.Element {
  const itemDrag = useReorderDrag({
    items: group.items,
    disabled,
    onReorder: onReorderItems,
  });

  const editingThisGroup = groupEdit?.gi === gi;
  const groupNameError = errors?.[`bookmarks.${gi}.name`];

  return (
    <EditorGroupCard
      title={group.name || "未命名分组"}
      countLabel={`${group.items.length} 项`}
      hasError={Boolean(groupNameError) || groupHasItemErrors(errors, "bookmarks", gi)}
      errorText={groupNameError}
      disabled={disabled}
      dragHandleProps={dragHandleProps}
      rowProps={rowProps}
      onEdit={onOpenGroupEdit}
      onDelete={onDeleteGroup}
      onMoveUp={onMoveGroupUp}
      onMoveDown={onMoveGroupDown}
      canMoveUp={canMoveGroupUp}
      canMoveDown={canMoveGroupDown}
      onAdd={onAddItem}
      addLabel="添加书签"
      contentClassName="sm:grid-cols-2 xl:grid-cols-3"
      nameEditor={
        editingThisGroup && groupEdit ? (
          <div className="space-y-1">
            <Input
              value={groupEdit.name}
              disabled={disabled}
              aria-label="分组名称"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onGroupNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onApplyGroupEdit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelGroupEdit();
                }
              }}
            />
            {groupNameError ? (
              <p className="text-xs text-destructive">{groupNameError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={onCancelGroupEdit}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={onApplyGroupEdit}
              >
                应用
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {group.items.length === 0 ? (
        <li className="col-span-full px-4 py-6 text-center text-sm text-muted-foreground">
          分组内暂无书签，点右上角 + 添加
        </li>
      ) : null}
      {group.items.map((item, ii) => (
        <EditorListRow
          key={`bmk-${gi}-${ii}`}
          icon={
            <BookmarkIconView
              icon={item.icon}
              abbr={item.abbr}
              name={item.name || "未命名书签"}
              className="size-8"
            />
          }
          title={item.name || "未命名书签"}
          subtitle={item.description?.trim() || undefined}
          host={summarizeHref(item.href) ?? undefined}
          tags={bookmarkTags(item)}
          hasError={itemHasErrors(errors, "bookmarks", gi, ii)}
          disabled={disabled}
          dragHandleProps={itemDrag.getHandleProps(ii)}
          rowProps={itemDrag.getRowProps(ii)}
          onEdit={() => onOpenItemEdit(ii)}
          onDelete={() => onDeleteItem(ii)}
          onMoveUp={() => onMoveItemUp(ii)}
          onMoveDown={() => onMoveItemDown(ii)}
          canMoveUp={ii > 0}
          canMoveDown={ii < group.items.length - 1}
          editing={editingItemIndex === ii}
        />
      ))}
    </EditorGroupCard>
  );
}

export function BookmarksEditor({
  value,
  onChange,
  disabled,
  errors,
}: BookmarksEditorProps): JSX.Element {
  const editing = useInlineGroupEditing<EditableBookmarkGroup, EditableBookmarkItem>({
    value,
    onChange,
    cloneItem,
  });

  const [addGroupOpen, setAddGroupOpen] = useState(false);

  const groupDrag = useReorderDrag({
    items: value,
    disabled,
    // 分组换位后所有下标偏移，行内编辑一并关闭
    onReorder: editing.reorderGroups,
  });

  return (
    <div className="space-y-4" data-slot="bookmarks-editor">
      <EditorPageHeader
        title="书签分组"
        description="拖拽手柄或点击上移下移按钮调整分组与书签顺序，点行内铅笔或标题就地编辑"
        actions={
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => setAddGroupOpen(true)}
          >
            添加分组
          </Button>
        }
      />

      {value.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
          暂无书签分组
        </p>
      ) : null}

      <div className="space-y-3">
        {value.map((group, gi) => (
          <BookmarkGroupBlock
            key={`bmk-g-${gi}`}
            group={group}
            gi={gi}
            disabled={disabled}
            errors={errors}
            dragHandleProps={groupDrag.getHandleProps(gi)}
            rowProps={groupDrag.getRowProps(gi)}
            editingItemIndex={
              editing.activeItemEdit?.gi === gi
                ? editing.activeItemEdit.ii
                : null
            }
            groupEdit={editing.activeGroupEdit}
            onOpenItemEdit={(ii) => editing.openItemEdit(gi, ii)}
            onOpenGroupEdit={() => editing.openGroupEdit(gi)}
            onGroupNameChange={editing.updateGroupName}
            onApplyGroupEdit={editing.applyGroupEdit}
            onCancelGroupEdit={editing.closeGroupEdit}
            onDeleteGroup={() => editing.deleteGroup(gi)}
            onMoveGroupUp={() => editing.moveGroup(gi, "up")}
            onMoveGroupDown={() => editing.moveGroup(gi, "down")}
            canMoveGroupUp={gi > 0}
            canMoveGroupDown={gi < value.length - 1}
            onAddItem={() => editing.addItemAndEdit(gi, emptyItem())}
            onReorderItems={(items) => editing.replaceItems(gi, items)}
            onDeleteItem={(ii) => editing.deleteItem(gi, ii)}
            onMoveItemUp={(ii) => editing.moveItem(gi, ii, "up")}
            onMoveItemDown={(ii) => editing.moveItem(gi, ii, "down")}
          />
        ))}
      </div>

      {/* 条目编辑弹窗：表单型编辑保持模态聚焦，浏览用卡片网格 */}
      <Dialog
        open={editing.activeItemEdit !== null}
        onOpenChange={(open) => {
          if (!open) editing.closeItemEdit();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              编辑书签
              {editing.activeItemEdit?.draft.name
                ? ` · ${editing.activeItemEdit.draft.name}`
                : ""}
            </DialogTitle>
            <DialogDescription>
              修改后点确定写回列表，再保存配置才会生效
            </DialogDescription>
          </DialogHeader>

          {editing.activeItemEdit ? (
            <div className="space-y-4">
              {value.length > 1 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="bookmark-target-group-select">所属分组</Label>
                  <Select
                    id="bookmark-target-group-select"
                    value={String(
                      editing.activeItemEdit.targetGi ??
                        editing.activeItemEdit.gi,
                    )}
                    disabled={disabled}
                    onChange={(e) =>
                      editing.updateItemTargetGroup(Number(e.target.value))
                    }
                  >
                    {value.map((g, idx) => (
                      <option key={`opt-bmk-group-${idx}`} value={idx}>
                        {g.name || `分组 ${idx + 1}`}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <BookmarkItemForm
                value={editing.activeItemEdit.draft}
                onChange={editing.updateItemDraft}
                {...(disabled !== undefined ? { disabled } : {})}
                errorPrefix={`bookmarks.${editing.activeItemEdit.gi}.items.${editing.activeItemEdit.ii}`}
                {...(errors !== undefined ? { errors } : {})}
              />
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={editing.closeItemEdit}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={editing.applyItemEdit}
            >
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddGroupDialog
        open={addGroupOpen}
        onOpenChange={setAddGroupOpen}
        title="添加书签分组"
        description="输入新分组的名称，创建后可向其中添加书签条目"
        placeholder="例如：常用推荐、工作开发、影音娱乐"
        disabled={disabled}
        onConfirm={(name) => {
          onChange([...value, emptyGroup(name)]);
        }}
      />
    </div>
  );
}
