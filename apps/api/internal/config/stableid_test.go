package config

import (
	"strconv"
	"strings"
	"testing"
)

// 固定输入的稳定 ID 前缀与长度，以及同一输入两次加载结果完全一致。
func TestStableIDsArePrefixedAndRepeatable(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{
		FileDocker:    testDockerYAML,
		FileServices:  testServicesYAML,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
	})
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")

	first, err := Load(dir)
	if err != nil {
		t.Fatalf("首次加载失败：%v", err)
	}
	second, err := Load(dir)
	if err != nil {
		t.Fatalf("二次加载失败：%v", err)
	}

	firstIDs := collectIDs(t, first)
	secondIDs := collectIDs(t, second)
	if len(firstIDs) == 0 {
		t.Fatal("测试配置应至少产生一个稳定 ID")
	}
	for name, id := range firstIDs {
		if repeat := secondIDs[name]; repeat != id {
			t.Errorf("%s 两次加载结果不同：%s 与 %s", name, id, repeat)
		}
	}

	// 哈希统一截断为 24 位十六进制，前缀按类型区分
	prefixes := map[string]string{
		"service":  "svc_",
		"probe":    "prb_",
		"widget":   "wgt_",
		"info":     "inf_",
		"bookmark": "bmk_",
	}
	for name, id := range firstIDs {
		kind, _, _ := strings.Cut(name, "/")
		prefix, known := prefixes[kind]
		if !known {
			t.Fatalf("未知 ID 类型：%q", name)
		}
		if len(id) != len(prefix)+24 {
			t.Errorf("%s 长度应为 %d，得到 %d（%s）", name, len(prefix)+24, len(id), id)
		}
		if !strings.HasPrefix(id, prefix) {
			t.Errorf("%s 前缀应为 %q，得到 %q", name, prefix, id)
		}
	}
}

// 按「类型/分组序号/条目序号」收集一份快照里的全部稳定 ID。
func collectIDs(t *testing.T, snapshot *Snapshot) map[string]string {
	t.Helper()
	ids := make(map[string]string)
	key := func(kind string, groupIndex, itemIndex int) string {
		return kind + "/" + strconv.Itoa(groupIndex) + "/" + strconv.Itoa(itemIndex)
	}

	for groupIndex, group := range snapshot.Config.Services {
		for itemIndex, item := range group.Items {
			service, ok := item.(ServiceJSON)
			if !ok {
				continue
			}
			ids[key("service", groupIndex, itemIndex)] = service.ID
			if service.HTTPProbe != nil {
				ids[key("probe", groupIndex, itemIndex)] = service.HTTPProbe.ProbeID
			}
			if service.Widget != nil && service.Widget.WidgetID != nil {
				ids[key("widget", groupIndex, itemIndex)] = *service.Widget.WidgetID
			}
		}
	}
	for index, widget := range snapshot.Config.InfoWidgets {
		ids[key("info", index, 0)] = widget.InfoID
	}
	for groupIndex, group := range snapshot.Config.Bookmarks {
		for itemIndex, item := range group.Items {
			bookmark, ok := item.(BookmarkJSON)
			if !ok {
				continue
			}
			ids[key("bookmark", groupIndex, itemIndex)] = bookmark.ID
		}
	}
	return ids
}
