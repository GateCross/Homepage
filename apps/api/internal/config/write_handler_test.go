package config

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 写回成功：返回 {ok: true}，磁盘立刻是新的，Store 不等监听事件就已换上新快照。
func TestServeConfigWriteUpdatesStoreImmediately(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings:  "title: 改前\nuseEqualHeights: false\n",
		FileServices:  "- Server:\n    - name: 保留\n      href: https://example.com/keep\n",
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})

	store := NewStore()
	if err := store.Load(dir); err != nil {
		t.Fatalf("初次加载失败：%v", err)
	}
	handler := NewHandler(store).WithConfigDir(dir)

	body := `{"settings":{"title":"改后","useEqualHeights":true,"layout":[]},
		"services":[{"name":"Server","items":[{"name":"保留","href":"https://example.com/keep"}]}],
		"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[{"name":"local","connection":"unix:///var/run/docker.sock"}]}`
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, ConfigPath, strings.NewReader(body)))

	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200；响应 %s", recorder.Code, recorder.Body.String())
	}
	response := decodeJSONMap(t, recorder.Body.Bytes())
	if ok, _ := response["ok"].(bool); !ok {
		t.Errorf("响应体应是 {ok: true}，实得 %s", recorder.Body.String())
	}

	// 快照立即生效，无需等待 fsnotify
	if title := store.Snapshot().Config.Settings.Title; title != "改后" {
		t.Errorf("Store 标题应为「改后」，实得 %q", title)
	}
	if !store.Snapshot().Config.Settings.UseEqualHeights {
		t.Error("Store 的等高开关应已更新")
	}

	// 读端点拿到的也是新配置
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, ConfigPath, nil))
	if !strings.Contains(recorder.Body.String(), "改后") {
		t.Errorf("读端点应输出新配置：%s", recorder.Body.String())
	}

	// 磁盘内容同样是新的
	rawSettings := mustRead(t, filepath.Join(dir, FileSettings))
	if !bytes.Contains(rawSettings, []byte("title: 改后")) {
		t.Errorf("磁盘上的标题未更新：\n%s", rawSettings)
	}
}

// 非法 JSON 返回 CONFIG_INVALID，且不落盘。
func TestServeConfigWriteRejectsInvalidJSON(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings:  "title: 原始\n",
		FileServices:  testServicesYAML,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})
	before := snapshotDirectory(t, dir)

	handler := NewHandler(NewStore()).WithConfigDir(dir)
	for name, body := range map[string]string{
		"语法错误": `{"settings": `,
		"空请求体": ``,
		"数组":   `[]`,
		"尾随内容": `{"settings":{}} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, ConfigPath, strings.NewReader(body)))

			if recorder.Code != http.StatusUnprocessableEntity {
				t.Fatalf("状态码 = %d，期望 422；响应 %s", recorder.Code, recorder.Body.String())
			}
			envelope := childMap(t, decodeJSONMap(t, recorder.Body.Bytes()), "error")
			if envelope["code"] != "CONFIG_INVALID" {
				t.Errorf("错误码应为 CONFIG_INVALID，实得 %v", envelope["code"])
			}
			assertDirectoryUnchanged(t, dir, before)
		})
	}
}

// 载荷语义非法时同样是 422：类型不符、内嵌凭据、未知组件类型。
func TestServeConfigWriteRejectsInvalidPayload(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings:  "title: 原始\n",
		FileServices:  testServicesYAML,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})
	before := snapshotDirectory(t, dir)
	handler := NewHandler(NewStore()).WithConfigDir(dir)

	const head = `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},`
	cases := map[string]struct {
		body     string
		wantCode string
		wantFile string
	}{
		"标题类型不符": {
			body:     `{"settings":{"title":1,"useEqualHeights":false,"layout":[]},"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			wantCode: "CONFIG_INVALID",
		},
		"内嵌凭据": {
			body: head + `"services":[],"bookmarks":[],"infoWidgets":[],
				"dockerEndpoints":[{"name":"remote","connection":"tcp://u:p@10.0.0.2:2375"}]}`,
			wantCode: codeDockerConnectionSensitive,
			wantFile: FileDocker,
		},
	}

	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, ConfigPath, strings.NewReader(testCase.body)))

			expectStatus := http.StatusUnprocessableEntity
			if recorder.Code != expectStatus {
				t.Fatalf("状态码 = %d，期望 %d；响应 %s", recorder.Code, expectStatus, recorder.Body.String())
			}
			envelope := childMap(t, decodeJSONMap(t, recorder.Body.Bytes()), "error")
			if envelope["code"] != testCase.wantCode {
				t.Errorf("错误码应为 %q，实得 %v", testCase.wantCode, envelope["code"])
			}
			if testCase.wantFile != "" && envelope["file"] != testCase.wantFile {
				t.Errorf("错误应定位到 %q，实得 %v", testCase.wantFile, envelope["file"])
			}
			// 响应不得回显连接串内容
			if strings.Contains(recorder.Body.String(), "10.0.0.2") {
				t.Error("错误响应不得回显连接串")
			}
			assertDirectoryUnchanged(t, dir, before)
		})
	}
}

// 未注入配置目录时写回按内部失败拒绝，不会落到当前工作目录。
func TestServeConfigWriteWithoutConfigDirIsRejected(t *testing.T) {
	resetConfigGate(t)
	handler := NewHandler(NewStore())

	body := `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
		"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, ConfigPath, strings.NewReader(body)))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，期望 500；响应 %s", recorder.Code, recorder.Body.String())
	}
	envelope := childMap(t, decodeJSONMap(t, recorder.Body.Bytes()), "error")
	if envelope["code"] != "INTERNAL" {
		t.Errorf("错误码应为 INTERNAL，实得 %v", envelope["code"])
	}
}

// 故障态下写回返回 CONFIG_FAULTED 与 500，错误码与前端契约一致。
func TestServeConfigWriteReportsFaultedState(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "title: 原始\n",
		FileDocker:   testDockerYAML,
	})
	handler := NewHandler(NewStore()).WithConfigDir(dir)
	configGate.open(configFaultedMessage)
	t.Cleanup(func() { configGate.close() })

	// 磁盘上配置仍完好时闸门会自动恢复，先把配置文件弄坏
	if err := os.WriteFile(filepath.Join(dir, FileSettings), []byte("title: [坏掉的\n"), 0o600); err != nil {
		t.Fatalf("写入损坏配置失败：%v", err)
	}

	body := `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
		"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, ConfigPath, strings.NewReader(body)))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，期望 500；响应 %s", recorder.Code, recorder.Body.String())
	}
	envelope := childMap(t, decodeJSONMap(t, recorder.Body.Bytes()), "error")
	if envelope["code"] != codeConfigFaulted {
		t.Errorf("错误码应为 %q，实得 %v", codeConfigFaulted, envelope["code"])
	}
}

// 非 PUT 方法仍走读取分支，不会被写回端点吞掉。
func TestServeHTTPDispatchesByMethod(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{FileSettings: "title: 读\n"})
	store := NewStore()
	if err := store.Load(dir); err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	handler := NewHandler(store).WithConfigDir(dir)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, ConfigPath, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET 状态码 = %d，期望 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "读") {
		t.Errorf("GET 应输出当前配置：%s", recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, ConfigPath+"/unknown", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知子路径状态码 = %d，期望 404", recorder.Code)
	}
}

// 写回载荷必须是单个 JSON 值，不能是两个拼在一起的对象。
func TestDecodeConfigWriteBodyRejectsTrailingContent(t *testing.T) {
	cases := map[string]bool{
		`{"settings":{}}`:      true,
		`{"settings":{}}{}`:    false,
		"{\"settings\":{}} \n": true,
		`{`:                    false,
	}
	for body, wantValid := range cases {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPut, ConfigPath, strings.NewReader(body))
		_, err := decodeConfigWriteBody(recorder, request)
		if (err == nil) != wantValid {
			t.Errorf("载荷 %q 的接受结果不符：err=%v", body, err)
		}
	}
}

// 写回请求体带旁路字段时仍然只认契约字段，磁盘不会出现多余内容。
func TestServeConfigWriteIgnoresBypassFields(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "title: 原始\n",
		FileDocker:   testDockerYAML,
	})
	handler := NewHandler(NewStore()).WithConfigDir(dir)

	body := `{"settings":{"title":"新标题","useEqualHeights":false,"layout":[]},
		"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[],
		"allowList":{"secrets":["leak-value"]},"resolvedSecrets":{"password":"leak-value"},"clientMeta":{}}`
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, ConfigPath, strings.NewReader(body)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200；响应 %s", recorder.Code, recorder.Body.String())
	}

	rawSettings := string(mustRead(t, filepath.Join(dir, FileSettings)))
	if strings.Contains(rawSettings, "leak-value") || strings.Contains(rawSettings, "allowList") {
		t.Errorf("旁路字段不得落盘：\n%s", rawSettings)
	}
}

// 序列化后的响应体确实是 JSON 对象且只有一个键。
func TestConfigWriteResponseShape(t *testing.T) {
	payload, err := json.Marshal(ConfigWriteResponse{OK: true})
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if string(payload) != `{"ok":true}` {
		t.Errorf("响应体形状不符：%s", payload)
	}
}
