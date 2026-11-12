package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 收集：组件密钥与 customapi 请求头值都进列表，出站 URL 不扫。
func TestCollectSensitiveValues(t *testing.T) {
	allowList := NewAllowList()
	allowList.WidgetTargets["wgt_1"] = WidgetTarget{
		Type:    "qbittorrent",
		URL:     "http://192.168.50.10:8080",
		Secrets: map[string]string{"username": "admin", "password": "pa55word", "token": ""},
		Options: map[string]any{},
	}
	allowList.WidgetTargets["wgt_2"] = WidgetTarget{
		Type: "customapi",
		URL:  "http://192.168.50.11:9000",
		Secrets: map[string]string{
			"apiKey": "key-value",
			// 与上面重复的取值只应出现一次
			"password": "pa55word",
		},
		Options: map[string]any{
			"method":  "GET",
			"headers": map[string]string{"Authorization": "Bearer token-abc"},
		},
	}

	secrets := CollectSensitiveValues(allowList)
	wanted := []string{"Bearer token-abc", "admin", "key-value", "pa55word"}
	if len(secrets) != len(wanted) {
		t.Fatalf("敏感值数量不符：%v", secrets)
	}
	for _, want := range wanted {
		if !containsString(secrets, want) {
			t.Errorf("缺少敏感值 %q：%v", want, secrets)
		}
	}

	// 出站目标不算敏感值，否则任何响应都会被判为泄露
	for _, secret := range secrets {
		if strings.Contains(secret, "192.168.50") {
			t.Errorf("出站 URL 不应进入敏感值列表：%q", secret)
		}
	}

	if values := CollectSensitiveValues(nil); values != nil {
		t.Errorf("空允许列表应返回 nil，得到 %v", values)
	}
}

// 扫描：序列化后的 JSON 含任一敏感值即命中，含转义形式同样命中。
func TestJSONContainsAnySecret(t *testing.T) {
	type card struct {
		Name   string `json:"name"`
		Note   string `json:"note,omitempty"`
		Secret string `json:"secret,omitempty"`
	}

	clean, err := json.Marshal(card{Name: "仪表盘"})
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if JSONContainsAnySecret(clean, []string{"pa55word"}) {
		t.Error("不含敏感值的数据不应命中")
	}
	if JSONContainsAnySecret(clean, nil) {
		t.Error("空敏感值列表恒为 false")
	}

	leaked, err := json.Marshal(card{Name: "仪表盘", Secret: "pa55word"})
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if !JSONContainsAnySecret(leaked, []string{"pa55word"}) {
		t.Errorf("含密钥的响应应被识别：%s", leaked)
	}
	if !JSONContainsAnySecret(leaked, []string{"other", "pa55word"}) {
		t.Error("任一敏感值命中即可")
	}

	// 引号与反斜杠在 JSON 里会被转义，原文比对不到时必须靠转义比对
	escapedSecret := `pa"55\word`
	escapedPayload, err := json.Marshal(card{Name: "仪表盘", Note: escapedSecret})
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if strings.Contains(string(escapedPayload), escapedSecret) {
		t.Fatal("该取值应被 JSON 转义，测试前提不成立")
	}
	if !JSONContainsAnySecret(escapedPayload, []string{escapedSecret}) {
		t.Errorf("转义后的敏感值应被识别：%s", escapedPayload)
	}

	// HTML 字符不参与转义，与前端 JSON.stringify 行为一致
	htmlPayload, err := json.Marshal(card{Name: "仪表盘", Note: "a<b&c>d"})
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if !JSONContainsAnySecret(htmlPayload, []string{"a<b&c>d"}) {
		t.Errorf("HTML 字符序列应被识别：%s", htmlPayload)
	}
}

// 规范化配置端点：正常快照输出结构对齐的 JSON，缓存头不得被中间层复用。
func TestServeConfigReturnsNormalizedJSON(t *testing.T) {
	store := NewStore()
	if err := store.Load(writeConfigDir(t, map[string]string{
		FileSettings:  "title: 实验室首页\n",
		FileServices:  testServicesYAML,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})); err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")

	recorder := httptest.NewRecorder()
	NewHandler(store).ServeConfig(recorder, httptest.NewRequest(http.MethodGet, ConfigPath, nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码应为 200，实得 %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type 不符：%q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control 不符：%q", got)
	}

	body := recorder.Body.String()
	if strings.Contains(body, "secret-value") {
		t.Errorf("规范化配置不得包含密钥明文：%s", body)
	}
	root := decodeJSONMap(t, recorder.Body.Bytes())
	settings := childMap(t, root, "settings")
	if settings["title"] != "实验室首页" {
		t.Errorf("标题不符：%v", settings["title"])
	}
	if layout, ok := settings["layout"].(map[string]any); !ok || len(layout) != 0 {
		t.Errorf("layout 应为对象：%v", settings["layout"])
	}
	if groups := childList(t, root, "services"); len(groups) != 1 {
		t.Errorf("服务分组数量不符：%d", len(groups))
	}
	if widgets := childList(t, root, "infoWidgets"); len(widgets) != 3 {
		t.Errorf("信息组件数量不符：%d", len(widgets))
	}
}

// 可编辑端点：密钥只输出状态，响应体内不得出现明文。
func TestServeEditableReturnsStatusOnly(t *testing.T) {
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")
	store := NewStore()
	if err := store.Load(writeConfigDir(t, map[string]string{
		FileServices: testServicesYAML,
		FileDocker:   testDockerYAML,
	})); err != nil {
		t.Fatalf("加载失败：%v", err)
	}

	recorder := httptest.NewRecorder()
	NewHandler(store).ServeEditable(recorder, httptest.NewRequest(http.MethodGet, ConfigEditablePath, nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码应为 200，实得 %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "secret-value") {
		t.Fatalf("可编辑视图不得包含密钥明文：%s", recorder.Body.String())
	}
	root := decodeJSONMap(t, recorder.Body.Bytes())
	if _, ok := root["settings"]; !ok {
		t.Errorf("缺少 settings 字段：%v", root)
	}
	for _, field := range []string{"services", "bookmarks", "infoWidgets", "dockerEndpoints"} {
		if _, ok := root[field]; !ok {
			t.Errorf("缺少 %q 字段：%v", field, root)
		}
	}
}

// 端点直接从快照读：换入新快照后立即生效，不需要重新读盘。
func TestHandlerReadsSnapshotInsteadOfDisk(t *testing.T) {
	store := NewStore()
	handler := NewHandler(store)

	first := httptest.NewRecorder()
	handler.ServeConfig(first, httptest.NewRequest(http.MethodGet, ConfigPath, nil))
	if title := childMap(t, decodeJSONMap(t, first.Body.Bytes()), "settings")["title"]; title != "首页" {
		t.Fatalf("空快照应输出默认标题，实得 %v", title)
	}

	if err := store.Load(writeConfigDir(t, map[string]string{
		FileSettings: "title: 第二版\n",
	})); err != nil {
		t.Fatalf("加载失败：%v", err)
	}

	second := httptest.NewRecorder()
	handler.ServeConfig(second, httptest.NewRequest(http.MethodGet, ConfigPath, nil))
	if title := childMap(t, decodeJSONMap(t, second.Body.Bytes()), "settings")["title"]; title != "第二版" {
		t.Errorf("应读取最新快照，实得 %v", title)
	}
}

// 密钥扫描兜底：快照里混进明文密钥的公开视图时，端点返回 Internal 而不是泄露。
func TestServeConfigRejectsLeakedSecret(t *testing.T) {
	snapshot := emptySnapshot()
	snapshot.AllowList.WidgetTargets["wgt_leak"] = WidgetTarget{
		Type:    "qbittorrent",
		URL:     "http://192.168.50.10:8080",
		Secrets: map[string]string{"password": "leaked-secret"},
	}
	// 手工构造一个把密钥写进 description 的坏快照，模拟规范化层漏检
	snapshot.Config.Services = []ServiceGroupJSON{{
		Name: "服务",
		Items: []any{ServiceJSON{
			ID:          "svc_leak",
			Name:        "泄露服务",
			Target:      "_blank",
			Description: stringPtrValue("leaked-secret"),
		}},
	}}

	recorder := httptest.NewRecorder()
	NewHandler(newStoreWithSnapshot(snapshot)).
		ServeConfig(recorder, httptest.NewRequest(http.MethodGet, ConfigPath, nil))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("含密钥的响应应返回 500，实得 %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "leaked-secret") {
		t.Fatalf("错误响应同样不得回显密钥：%s", recorder.Body.String())
	}
	body := decodeJSONMap(t, recorder.Body.Bytes())
	if code := childMap(t, body, "error")["code"]; code != "INTERNAL" {
		t.Errorf("错误码应为 INTERNAL，实得 %v", code)
	}
}

// 同一份扫描兜底对可编辑端点生效。
func TestServeEditableRejectsLeakedSecret(t *testing.T) {
	snapshot := emptySnapshot()
	snapshot.AllowList.WidgetTargets["wgt_leak"] = WidgetTarget{
		Type:    "customapi",
		URL:     "http://192.168.50.10:9000",
		Secrets: map[string]string{},
		Options: map[string]any{"headers": map[string]string{"Authorization": "Bearer leaked-token"}},
	}
	snapshot.Raw[FileSettings] = map[string]any{"title": "Bearer leaked-token"}

	recorder := httptest.NewRecorder()
	NewHandler(newStoreWithSnapshot(snapshot)).
		ServeEditable(recorder, httptest.NewRequest(http.MethodGet, ConfigEditablePath, nil))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("含请求头值的响应应返回 500，实得 %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "leaked-token") {
		t.Fatalf("错误响应不得回显敏感值：%s", recorder.Body.String())
	}
}

// 校验函数：字符串切片是否包含目标值。
func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

// 取字符串指针，便于构造快照。
func stringPtrValue(value string) *string { return &value }

// 用给定快照直接替换 Store 的当前快照，仅测试使用。
func newStoreWithSnapshot(snapshot *Snapshot) *Store {
	store := NewStore()
	store.mu.Lock()
	store.cur = snapshot
	store.mu.Unlock()
	return store
}
