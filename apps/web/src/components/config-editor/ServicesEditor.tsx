import { useMemo, useState, type JSX } from "react";

import type {
  EditableDockerEndpoint,
  EditableServiceGroupWrite,
  EditableServiceItemWrite,
} from "@/lib/contracts";

import {
  EditorGroupCard,
  EditorListRow,
  useReorderDrag,
} from "@/components/config-editor/EditorListChrome";
import { DockerImportDialog } from "@/components/config-editor/DockerImportDialog";
import { ServiceItemForm } from "@/components/config-editor/ServiceItemForm";
import { ServiceIconView } from "@/components/shared/ResolvedIconView";
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
import { groupHasItemErrors, itemHasErrors } from "@/lib/editor-paths";
import {
  cloneService,
  emptyGroup,
  emptyService,
  serviceKeywords,
} from "@/lib/service-model";

export type ServicesEditorProps = {
  value: EditableServiceGroupWrite[];
  onChange: (next: EditableServiceGroupWrite[]) => void;
  dockerEndpoints?: EditableDockerEndpoint[];
  disabled?: boolean;
  errors?: Record<string, string>;
};

type EditTarget =
  | { kind: "group"; gi: number }
  | { kind: "item"; gi: number; ii: number };





function ServiceGroupBlock({
  group,
  gi,
  disabled,
  errors,
  dragHandleProps,
  rowProps,
  onEditGroup,
  onDeleteGroup,
  onAddService,
  onEditItem,
  onReorderItems,
  onDeleteItem,
}: {
  group: EditableServiceGroupWrite;
  gi: number;
  disabled?: boolean | undefined;
  errors?: Record<string, string> | undefined;
  dragHandleProps: ReturnType<
    ReturnType<typeof useReorderDrag>["getHandleProps"]
  >;
  rowProps: ReturnType<ReturnType<typeof useReorderDrag>["getRowProps"]>;
  onEditGroup: () => void;
  onDeleteGroup: () => void;
  onAddService: () => void;
  onEditItem: (ii: number) => void;
  onReorderItems: (items: EditableServiceItemWrite[]) => void;
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
        Boolean(errors?.[`services.${gi}.name`]) || groupHasItemErrors(errors, "services", gi)
      }
      errorText={errors?.[`services.${gi}.name`]}
      disabled={disabled}
      dragHandleProps={dragHandleProps}
      rowProps={rowProps}
      onEdit={onEditGroup}
      onDelete={onDeleteGroup}
      onAdd={onAddService}
      addLabel="添加服务"
    >
      {group.items.length === 0 ? (
        <li className="px-4 py-6 text-center text-sm text-muted-foreground">
          分组内暂无服务，点右上角 + 添加
        </li>
      ) : null}
      {group.items.map((item, ii) => (
        <EditorListRow
          key={`svc-${gi}-${ii}`}
          icon={
            <ServiceIconView
              icon={item.icon}
              name={item.name || "未命名服务"}
              className="size-8"
            />
          }
          title={item.name || "未命名服务"}
          tags={serviceKeywords(item)}
          hasError={itemHasErrors(errors, "services", gi, ii)}
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

export function ServicesEditor({
  value,
  onChange,
  dockerEndpoints = [],
  disabled,
  errors,
}: ServicesEditorProps): JSX.Element {
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [draftItem, setDraftItem] = useState<EditableServiceItemWrite | null>(
    null,
  );
  const [draftGroupName, setDraftGroupName] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const openItemEdit = (
    gi: number,
    ii: number,
    itemOverride?: EditableServiceItemWrite,
  ): void => {
    const item = itemOverride ?? value[gi]?.items[ii];
    if (!item) return;
    setDraftItem(cloneService(item));
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
    patch: Partial<EditableServiceGroupWrite>,
  ): void => {
    onChange(value.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  };

  const addServiceAndEdit = (gi: number): void => {
    const group = value[gi];
    if (!group) return;
    const created = emptyService();
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
    if (editTarget?.kind === "item") return "编辑服务";
    return "";
  }, [editTarget]);

  const itemErrorPrefix =
    editTarget?.kind === "item"
      ? `services.${editTarget.gi}.items.${editTarget.ii}`
      : "";

  return (
    <div className="space-y-4" data-slot="services-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          拖拽左侧手柄可调整分组与服务顺序
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setImportOpen(true)}
          >
            从 Docker 导入
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...value, emptyGroup()])}
          >
            添加分组
          </Button>
        </div>
      </div>

      {value.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
          暂无服务分组
        </p>
      ) : null}

      <div className="space-y-3">
        {value.map((group, gi) => (
          <ServiceGroupBlock
            key={`svc-g-${gi}`}
            group={group}
            gi={gi}
            disabled={disabled}
            errors={errors}
            dragHandleProps={groupDrag.getHandleProps(gi)}
            rowProps={groupDrag.getRowProps(gi)}
            onEditGroup={() => openGroupEdit(gi)}
            onDeleteGroup={() => onChange(value.filter((_, i) => i !== gi))}
            onAddService={() => addServiceAndEdit(gi)}
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
              {errors?.[`services.${editTarget.gi}.name`] ? (
                <p className="text-xs text-destructive">
                  {errors[`services.${editTarget.gi}.name`]}
                </p>
              ) : null}
            </div>
          ) : null}

          {editTarget?.kind === "item" && draftItem ? (
            <ServiceItemForm
              value={draftItem}
              onChange={setDraftItem}
              {...(disabled !== undefined ? { disabled } : {})}
              errorPrefix={itemErrorPrefix}
              {...(errors !== undefined ? { errors } : {})}
              dockerEndpoints={dockerEndpoints}
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

      <DockerImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        value={value}
        onChange={onChange}
        dockerEndpoints={dockerEndpoints}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    </div>
  );
}
