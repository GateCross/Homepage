package config

import "testing"

// 非空 layout 的合并语义（此前只有 "layout":[] 的空用例）：
// 编辑器列出的分组覆盖 columns 并保留未知子键；
// 未列出的分组保留未知子键、丢掉 columns；仅剩 columns 的分组整体删除；
// 合并结果为空时整个 layout 键从 settings 上删除。
func TestApplyLayoutMergeSemantics(t *testing.T) {
	base := newOrderedMap(4)
	diskLayout := newOrderedMap(4)
	server := newOrderedMap(2)
	server.set("columns", 6)
	server.set("style", "row")
	diskLayout.set("Server", server)
	temp := newOrderedMap(1)
	temp.set("columns", 3)
	diskLayout.set("Temp", temp)
	apps := newOrderedMap(2)
	apps.set("columns", 2)
	apps.set("fullWidth", true)
	diskLayout.set("Apps", apps)
	base.set("layout", diskLayout)

	applyLayout(base, []EditableLayoutEntry{
		{GroupName: "Server", MaxColumns: 4},
		{GroupName: "  ", MaxColumns: 9}, // 空白分组名应被忽略
	})

	layout, ok := base.values["layout"].(*orderedMap)
	if !ok {
		t.Fatalf("layout 应保留为对象，实得 %T", base.values["layout"])
	}
	if len(layout.keys) != 2 {
		t.Fatalf("应剩 Server 与 Apps 两个分组（Temp 仅含 columns 应删除），实得 %v", layout.keys)
	}

	mergedServer, ok := layout.values["Server"].(*orderedMap)
	if !ok {
		t.Fatalf("Server 应为对象，实得 %T", layout.values["Server"])
	}
	if mergedServer.values["columns"] != 4 {
		t.Fatalf("Server columns 应被编辑器覆盖为 4，实得 %v", mergedServer.values["columns"])
	}
	if mergedServer.values["style"] != "row" {
		t.Fatalf("Server 的未知子键 style 应保留，实得 %v", mergedServer.values["style"])
	}

	mergedApps, ok := layout.values["Apps"].(*orderedMap)
	if !ok {
		t.Fatalf("Apps 应为对象，实得 %T", layout.values["Apps"])
	}
	if _, exists := mergedApps.values["columns"]; exists {
		t.Fatal("未列出分组的 columns 应被丢弃")
	}
	if mergedApps.values["fullWidth"] != true {
		t.Fatalf("Apps 的未知子键 fullWidth 应保留，实得 %v", mergedApps.values["fullWidth"])
	}
}

// 编辑器 layout 为空数组：仅含 columns 的分组删除，保留未知子键的分组让 layout 键继续存在。
func TestApplyLayoutEmptyEditorKeepsUnknownSubkeys(t *testing.T) {
	base := newOrderedMap(2)
	diskLayout := newOrderedMap(2)
	temp := newOrderedMap(1)
	temp.set("columns", 3)
	diskLayout.set("Temp", temp)
	apps := newOrderedMap(1)
	apps.set("fullWidth", true)
	diskLayout.set("Apps", apps)
	base.set("layout", diskLayout)

	applyLayout(base, []EditableLayoutEntry{})

	layout, ok := base.values["layout"].(*orderedMap)
	if !ok {
		t.Fatalf("有未知子键的分组存在时 layout 应保留，实得 %T", base.values["layout"])
	}
	if len(layout.keys) != 1 || layout.keys[0] != "Apps" {
		t.Fatalf("应只剩 Apps，实得 %v", layout.keys)
	}
}

// 磁盘 layout 仅含 columns 类分组且编辑器未列出任何分组时，layout 键整体删除。
func TestApplyLayoutEmptyResultRemovesKey(t *testing.T) {
	base := newOrderedMap(2)
	diskLayout := newOrderedMap(1)
	temp := newOrderedMap(1)
	temp.set("columns", 3)
	diskLayout.set("Temp", temp)
	base.set("layout", diskLayout)

	applyLayout(base, []EditableLayoutEntry{})

	if _, exists := base.values["layout"]; exists {
		t.Fatal("合并结果为空时 layout 键应整体删除")
	}
}

// 编辑器调整布局分组顺序时，写回应严格遵循编辑器传入的顺序，允许书签与服务任意调序。
func TestApplyLayoutReorderPreservesEditorOrder(t *testing.T) {
	base := newOrderedMap(2)
	diskLayout := newOrderedMap(3)

	server := newOrderedMap(1)
	server.set("columns", 6)
	diskLayout.set("Server", server)

	docker := newOrderedMap(1)
	docker.set("columns", 4)
	diskLayout.set("Docker", docker)

	pt := newOrderedMap(1)
	pt.set("columns", 8)
	diskLayout.set("PT", pt)

	base.set("layout", diskLayout)

	// 编辑器将 PT 调到最前：PT -> Server -> Docker
	applyLayout(base, []EditableLayoutEntry{
		{GroupName: "PT", MaxColumns: 8},
		{GroupName: "Server", MaxColumns: 6},
		{GroupName: "Docker", MaxColumns: 4},
	})

	layout, ok := base.values["layout"].(*orderedMap)
	if !ok {
		t.Fatalf("layout 应为对象，实得 %T", base.values["layout"])
	}

	expectedOrder := []string{"PT", "Server", "Docker"}
	if len(layout.keys) != len(expectedOrder) {
		t.Fatalf("分组数量不符，实得 %v", layout.keys)
	}
	for i, name := range expectedOrder {
		if layout.keys[i] != name {
			t.Errorf("第 %d 个分组名称不符，预期 %s，实得 %s（全部为 %v）", i, name, layout.keys[i], layout.keys)
		}
	}
}
