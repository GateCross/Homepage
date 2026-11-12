package config

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// 五文件全部缺失时：加载不报错，规范化配置与可编辑视图都为空而字段齐全。
func TestMissingFilesYieldEmptyConfigAndEditable(t *testing.T) {
	store := NewStore()
	if err := store.Load(t.TempDir()); err != nil {
		t.Fatalf("全部缺失不应报错：%v", err)
	}

	snapshot := store.Snapshot()
	if snapshot.Config.Settings.Title == "" {
		t.Error("设置段应有默认标题")
	}
	if len(snapshot.Config.Services) != 0 || len(snapshot.Config.Bookmarks) != 0 || len(snapshot.Config.InfoWidgets) != 0 {
		t.Fatalf("空目录应得到空配置：%+v", snapshot.Config)
	}

	editable, err := BuildEditableConfig(snapshot)
	if err != nil {
		t.Fatalf("空快照投影不应报错：%v", err)
	}
	if len(editable.Services) != 0 || len(editable.Bookmarks) != 0 || len(editable.InfoWidgets) != 0 {
		t.Fatalf("可编辑视图应为空数组：%+v", editable)
	}
	if len(editable.DockerEndpoints) != 0 {
		t.Fatalf("空目录不应有 docker 端点：%+v", editable.DockerEndpoints)
	}
	if editable.Settings.Title != "" || editable.Settings.UseEqualHeights {
		t.Fatalf("设置段应回到零值：%+v", editable.Settings)
	}

	// 空数组序列化后是 []，不能是 null，否则前端契约校验失败
	payload, err := json.Marshal(editable)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	for _, field := range []string{"services", "bookmarks", "infoWidgets", "dockerEndpoints"} {
		if !strings.Contains(string(payload), `"`+field+`":[]`) {
			t.Errorf("字段 %q 应序列化为空数组：%s", field, payload)
		}
	}
	if !strings.Contains(string(payload), `"layout":[]`) {
		t.Errorf("布局应序列化为空数组：%s", payload)
	}
}

// 服务与书签的可编辑投影：展示字段原样保留，密钥字段只给状态。
func TestEditableServicesAndBookmarks(t *testing.T) {
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")
	dir := writeConfigDir(t, map[string]string{
		FileDocker:    testDockerYAML,
		FileServices:  testServicesYAML,
		FileBookmarks: testBookmarksYAML,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	editable, err := BuildEditableConfig(snapshot)
	if err != nil {
		t.Fatalf("投影失败：%v", err)
	}

	payload, err := json.Marshal(editable)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	// 不透明投影最直接的断言：明文密钥绝不能出现在响应体里
	if strings.Contains(string(payload), "secret-value") {
		t.Fatalf("可编辑视图不得包含密钥明文：%s", payload)
	}

	root := decodeJSONMap(t, payload)
	groups := childList(t, root, "services")
	if len(groups) != 1 {
		t.Fatalf("服务分组数量不符：%d", len(groups))
	}
	items := childList(t, listMapAt(t, groups, 0), "items")
	if len(items) != 4 {
		t.Fatalf("服务条目数量不符：%d", len(items))
	}

	qbittorrent := findItemByName(t, items, "qBittorrent")
	if href, _ := qbittorrent["href"].(string); href != "http://192.168.50.10:8080" {
		t.Errorf("href 应保留原始写法，得到 %v", qbittorrent["href"])
	}
	if docker := childMap(t, qbittorrent, "docker"); docker["server"] != "my-docker" || docker["container"] != "qbittorrent" {
		t.Errorf("容器引用不符：%v", docker)
	}

	widget := childMap(t, qbittorrent, "widget")
	if widget["type"] != "qbittorrent" {
		t.Errorf("组件类型不符：%v", widget["type"])
	}
	if status := childMap(t, widget, "password")["status"]; status != SecretStatusConfigured {
		t.Errorf("已配置密码应输出 %q，得到 %v", SecretStatusConfigured, status)
	}
	if status := childMap(t, widget, "username")["status"]; status != SecretStatusConfigured {
		t.Errorf("已配置用户名应输出 %q，得到 %v", SecretStatusConfigured, status)
	}
	if _, exists := widget["key"]; exists {
		t.Error("未声明的密钥字段不得输出")
	}

	// 未配置密钥：空串状态为 unset
	probe := childMap(t, listMapAt(t, items, 0), "httpProbe")
	if probe["url"] != "https://192.168.50.100:8006" {
		t.Errorf("探测地址不符：%v", probe["url"])
	}

	bookmarkGroups := childList(t, root, "bookmarks")
	bookmarks := childList(t, listMapAt(t, bookmarkGroups, 0), "items")
	if href, _ := listMapAt(t, bookmarks, 0)["href"].(string); href != "https://hdsky.me/" {
		t.Errorf("书签链接应保留原始写法，得到 %v", listMapAt(t, bookmarks, 0)["href"])
	}
}

// 密钥为空串与非字符串时都算未配置；声明过才输出字段。
func TestEditableSecretStatuses(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{
		FileServices: `- 服务:
    - name: 空密码
      href: http://192.168.50.10:8080
      widget:
        type: qbittorrent
        url: http://192.168.50.10:8080
        username: ""
    - name: 数字密钥
      href: http://192.168.50.11:8080
      widget:
        type: emby
        url: http://192.168.50.11:8096
        key: 12345
`,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	editable, err := BuildEditableConfig(snapshot)
	if err != nil {
		t.Fatalf("投影失败：%v", err)
	}
	payload, _ := json.Marshal(editable)
	items := childList(t, decodeJSONMap(t, payload), "services")
	services := childList(t, listMapAt(t, items, 0), "items")

	emptyWidget := childMap(t, findItemByName(t, services, "空密码"), "widget")
	if status := childMap(t, emptyWidget, "username")["status"]; status != SecretStatusUnset {
		t.Errorf("空串应输出 %q，得到 %v", SecretStatusUnset, status)
	}
	if _, exists := emptyWidget["password"]; exists {
		t.Error("未声明的密钥字段不得输出")
	}

	numericWidget := childMap(t, findItemByName(t, services, "数字密钥"), "widget")
	if status := childMap(t, numericWidget, "key")["status"]; status != SecretStatusUnset {
		t.Errorf("非字符串密钥应输出 %q，得到 %v", SecretStatusUnset, status)
	}
}

// 信息组件与 docker 端点的可编辑投影。
func TestEditableInfoWidgetsAndDockerEndpoints(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{
		FileDocker:  testDockerYAML,
		FileWidgets: testWidgetsYAML,
		FileServices: `- 服务:
    - name: 离线服务
      href: http://192.168.50.10:9999
      server: my-docker
      container: offline
`,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	editable, err := BuildEditableConfig(snapshot)
	if err != nil {
		t.Fatalf("投影失败：%v", err)
	}
	payload, _ := json.Marshal(editable)
	root := decodeJSONMap(t, payload)

	widgets := childList(t, root, "infoWidgets")
	if len(widgets) != 3 {
		t.Fatalf("信息组件数量不符：%d", len(widgets))
	}
	datetime := listMapAt(t, widgets, 0)
	if datetime["type"] != "datetime" || datetime["timezone"] != "Asia/Shanghai" {
		t.Errorf("时间组件投影不符：%v", datetime)
	}
	openmeteo := listMapAt(t, widgets, 1)
	if openmeteo["cityId"] != "101270401" || openmeteo["location"] != "绵阳" {
		t.Errorf("天气组件投影不符：%v", openmeteo)
	}
	resources := listMapAt(t, widgets, 2)
	if resources["type"] != "resources" || resources["disk"] != "/" {
		t.Errorf("资源组件投影不符：%v", resources)
	}
	if cpu, ok := resources["cpu"].(bool); !ok || !cpu {
		t.Errorf("资源组件应保留 cpu 开关：%v", resources["cpu"])
	}

	endpoints := childList(t, root, "dockerEndpoints")
	if len(endpoints) != 2 {
		t.Fatalf("端点数量不符：%d", len(endpoints))
	}
	if name := listMapAt(t, endpoints, 0)["name"]; name != "my-docker" {
		t.Errorf("端点应按声明顺序输出，首个为 %v", name)
	}
	if connection := listMapAt(t, endpoints, 0)["connection"]; connection != "unix:///var/run/docker.sock" {
		t.Errorf("连接串不符：%v", connection)
	}
}

// 隐藏条目仍进入可编辑视图，但规范化配置里不出现。
func TestEditableKeepsHiddenServices(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{
		FileServices: `- 服务:
    - name: 可见
      href: http://192.168.50.10:8080
    - name: 隐藏
      href: http://192.168.50.11:8080
      hidden: true
`,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	if len(snapshot.Config.Services[0].Items) != 1 {
		t.Fatalf("隐藏条目不得进入公开视图：%+v", snapshot.Config.Services[0].Items)
	}

	editable, err := BuildEditableConfig(snapshot)
	if err != nil {
		t.Fatalf("投影失败：%v", err)
	}
	if len(editable.Services[0].Items) != 2 {
		t.Fatalf("可编辑视图应保留隐藏条目：%+v", editable.Services[0].Items)
	}
	if hidden := editable.Services[0].Items[1].Hidden; hidden == nil || !*hidden {
		t.Errorf("隐藏标记应原样输出：%+v", editable.Services[0].Items[1])
	}
}

// docker 连接串含内嵌凭据时整体拒绝，且错误文案不含原串。
func TestEditableRejectsDockerConnectionWithUserInfo(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{
		FileDocker: "remote: tcp://user:pa55word@10.0.0.2:2375\n",
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	_, err = BuildEditableConfig(snapshot)
	if err == nil {
		t.Fatal("内嵌凭据的连接串应返回错误")
	}
	var configErr *EditableConfigError
	if !strings.Contains(err.Error(), "不得包含用户名或密码") {
		t.Errorf("错误文案不符：%v", err)
	}
	if !errors.As(err, &configErr) {
		t.Fatalf("错误类型不符：%T", err)
	}
	if configErr.Code != codeDockerConnectionSensitive {
		t.Errorf("错误码应为 %q，得到 %q", codeDockerConnectionSensitive, configErr.Code)
	}
	if configErr.File != FileDocker {
		t.Errorf("错误应定位到 docker.yaml，得到 %q", configErr.File)
	}
	if strings.Contains(configErr.Path, "pa55word") {
		t.Errorf("错误定位不得泄露连接串内容：%q", configErr.Path)
	}
}

// 按名称查找服务条目，找不到直接失败。
func findItemByName(t *testing.T, items []any, name string) map[string]any {
	t.Helper()
	for _, item := range items {
		doc, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if doc["name"] == name {
			return doc
		}
	}
	t.Fatalf("未找到名称为 %q 的条目", name)
	return nil
}
