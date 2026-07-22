import { useMemo, useState, type JSX } from "react";

import type {
  EditableBookmarkGroup,
  EditableBookmarkItem,
} from "@homepage/domain";

import {
  EditorGroupCard,
  EditorListRow,
  useReorderDrag,
} from "@/components/config-editor/EditorListChrome";
import { ImageAssetField } from "@/components/config-editor/ImageAssetField";
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

export type BookmarksEditorProps = {
  value: EditableBookmarkGroup[];
  onChange: (next: EditableBookmarkGroup[]) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
};

type EditTarget =
  | { kind: "group"; gi: number }
  | { kind: "item"; gi: number; ii: number };

function emptyItem(): EditableBookmarkItem {
  return { name: "新书签", href: "https://example.com" };
}

function emptyGroup(): EditableBookmarkGroup {
  return { name: "新分组", items: [emptyItem()] };
}

function cloneItem(item: EditableBookmarkItem): EditableBookmarkItem {
  return structuredClone(item);
}

function summarizeHref(href: string | undefined): string | null {
  if (!href?.trim()) return null;
  try {
    const u = new URL(href);
    return u.host || href;
  } catch {
    return href.length > 36 ? `${href.slice(0, 36)}…` : href;
  }
}

function bookmarkKeywords(item: EditableBookmarkItem): string[] {
  const tags: string[] = [];
  const host = summarizeHref(item.href);
  if (host) tags.push(host);
  if (item.abbr?.trim()) tags.push(item.abbr.trim());
  if (item.description?.trim()) tags.push(item.description.trim());
  return tags;
}

function groupHasItemErrors(
  errors: Record<string, string> | undefined,
  gi: number,
): boolean {
  if (!errors) return false;
  const prefix = `bookmarks.${gi}.`;
  return Object.keys(errors).some(
    (k) => k.startsWith(prefix) && k !== `bookmarks.${gi}.name`,
  );
}

function itemHasErrors(
  errors: Record<string, string> | undefined,
  gi: number,
  ii: number,
): boolean {
  if (!errors) return false;
  const prefix = `bookmarks.${gi}.items.${ii}.`;
  return Object.keys(errors).some((k) => k.startsWith(prefix));
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
  onEditGroup,
  onDeleteGroup,
  onAddItem,
  onEditItem,
  onReorderItems,
  onDeleteItem,
}: {
  group: EditableBookmarkGroup;
  gi: number;
  disabled?: boolean | undefined;
  errors?: Record<string, string> | undefined;
  dragHandleProps: ReturnType<
    ReturnType<typeof useReorderDrag>["getHandleProps"]
  >;
  rowProps: ReturnType<ReturnType<typeof useReorderDrag>["getRowProps"]>;
  onEditGroup: () => void;
  onDeleteGroup: () => void;
  onAddItem: () => void;
  onEditItem: (ii: number) => void;
  onReorderItems: (items: EditableBookmarkItem[]) => void;
  onDeleteItem: (ii: number) => void;
}): JSX.Element {
  const itemDrag = useReorderDrag({
    items: group.items,
    disabled,
    onReorder: onReorderItems,
  });

  return (
    <EditorGroupCard
      title={group.name || "未命名分组"}
      countLabel={`${group.items.length} 项`}
      hasError={
        Boolean(errors?.[`bookmarks.${gi}.name`]) ||
        groupHasItemErrors(errors, gi)
      }
      errorText={errors?.[`bookmarks.${gi}.name`]}
      disabled={disabled}
      dragHandleProps={dragHandleProps}
      rowProps={rowProps}
      onEdit={onEditGroup}
      onDelete={onDeleteGroup}
      onAdd={onAddItem}
      addLabel="添加书签"
    >
      {group.items.length === 0 ? (
        <li className="px-4 py-6 text-center text-sm text-muted-foreground">
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
          tags={bookmarkKeywords(item)}
          hasError={itemHasErrors(errors, gi, ii)}
          disabled={disabled}
          dragHandleProps={itemDrag.getHandleProps(ii)}
          rowProps={itemDrag.getRowProps(ii)}
          onEdit={() => onEditItem(ii)}
          onDelete={() => onDeleteItem(ii)}
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
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [draftItem, setDraftItem] = useState<EditableBookmarkItem | null>(null);
  const [draftGroupName, setDraftGroupName] = useState("");

  const openItemEdit = (
    gi: number,
    ii: number,
    itemOverride?: EditableBookmarkItem,
  ): void => {
    const item = itemOverride ?? value[gi]?.items[ii];
    if (!item) return;
    setDraftItem(cloneItem(item));
    setEditTarget({ kind: "item", gi, ii });
  };

  const openGroupEdit = (gi: number): void => {
    const group = value[gi];
    if (!group) return;
    setDraftGroupName(group.name);
    setEditTarget({ kind: "group", gi });
  };

  const closeEdit = (): void => {
    setEditTarget(null);
    setDraftItem(null);
    setDraftGroupName("");
  };

  const applyItemEdit = (): void => {
    if (editTarget?.kind !== "item" || !draftItem) return;
    const { gi, ii } = editTarget;
    if (!value[gi]) return;
    onChange(
      value.map((g, i) =>
        i === gi
          ? {
              ...g,
              items: g.items.map((it, idx) => (idx === ii ? draftItem : it)),
            }
          : g,
      ),
    );
    closeEdit();
  };

  const applyGroupEdit = (): void => {
    if (editTarget?.kind !== "group") return;
    const { gi } = editTarget;
    onChange(
      value.map((g, i) =>
        i === gi ? { ...g, name: draftGroupName } : g,
      ),
    );
    closeEdit();
  };

  const updateGroup = (
    gi: number,
    patch: Partial<EditableBookmarkGroup>,
  ): void => {
    onChange(value.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  };

  const addItemAndEdit = (gi: number): void => {
    const group = value[gi];
    if (!group) return;
    const created = emptyItem();
    const nextItems = [...group.items, created];
    onChange(
      value.map((g, i) => (i === gi ? { ...g, items: nextItems } : g)),
    );
    openItemEdit(gi, nextItems.length - 1, created);
  };

  const groupDrag = useReorderDrag({
    items: value,
    disabled,
    onReorder: onChange,
  });

  const dialogOpen = editTarget !== null;

  const dialogTitle = useMemo(() => {
    if (editTarget?.kind === "group") return "编辑分组";
    if (editTarget?.kind === "item") return "编辑书签";
    return "";
  }, [editTarget]);

  const itemErrorPrefix =
    editTarget?.kind === "item"
      ? `bookmarks.${editTarget.gi}.items.${editTarget.ii}`
      : "";

  return (
    <div className="space-y-4" data-slot="bookmarks-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          拖拽左侧手柄可调整分组与书签顺序
        </p>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...value, emptyGroup()])}
        >
          添加分组
        </Button>
      </div>

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
            onEditGroup={() => openGroupEdit(gi)}
            onDeleteGroup={() => onChange(value.filter((_, i) => i !== gi))}
            onAddItem={() => addItemAndEdit(gi)}
            onEditItem={(ii) => openItemEdit(gi, ii)}
            onReorderItems={(items) => updateGroup(gi, { items })}
            onDeleteItem={(ii) =>
              updateGroup(gi, {
                items: group.items.filter((_, idx) => idx !== ii),
              })
            }
          />
        ))}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {editTarget?.kind === "item"
                ? "修改后点确定写回列表，再保存配置才会生效。"
                : "修改分组名称，点确定写回列表。"}
            </DialogDescription>
          </DialogHeader>

          {editTarget?.kind === "group" ? (
            <div className="space-y-1">
              <Label>分组名称</Label>
              <Input
                value={draftGroupName}
                disabled={disabled}
                onChange={(e) => setDraftGroupName(e.target.value)}
                autoFocus
              />
              {errors?.[`bookmarks.${editTarget.gi}.name`] ? (
                <p className="text-xs text-destructive">
                  {errors[`bookmarks.${editTarget.gi}.name`]}
                </p>
              ) : null}
            </div>
          ) : null}

          {editTarget?.kind === "item" && draftItem ? (
            <BookmarkItemForm
              value={draftItem}
              onChange={setDraftItem}
              {...(disabled !== undefined ? { disabled } : {})}
              errorPrefix={itemErrorPrefix}
              {...(errors !== undefined ? { errors } : {})}
            />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeEdit}>
              取消
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (editTarget?.kind === "group") applyGroupEdit();
                else applyItemEdit();
              }}
            >
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
