package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// PUT /api/config 必须注册到配置挂载点，GET 仍只走读取分支。
func TestConfigMountAcceptsPut(t *testing.T) {
	var methods []string
	configMount := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	server := httptest.NewServer(NewRouter(Options{
		Mounts: Mounts{Config: configMount},
		Static: testStatic(),
	}))
	defer server.Close()

	request, err := http.NewRequest(http.MethodPut, server.URL+"/api/config", strings.NewReader(`{"settings":{}}`))
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/config 状态码 = %d，期望 200", response.StatusCode)
	}

	if len(methods) != 1 || methods[0] != http.MethodPut {
		t.Fatalf("挂载点应收到一次 PUT，实得 %v", methods)
	}
}

// 未注册的方法不进入配置挂载点，而是 JSON 404。
func TestConfigMountRejectsOtherMethods(t *testing.T) {
	configMount := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	server := httptest.NewServer(NewRouter(Options{
		Mounts: Mounts{Config: configMount},
		Static: testStatic(),
	}))
	defer server.Close()

	for _, method := range []string{http.MethodDelete, http.MethodPatch} {
		request, err := http.NewRequest(method, server.URL+"/api/config", nil)
		if err != nil {
			t.Fatalf("构造请求失败：%v", err)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("请求失败：%v", err)
		}
		body := make([]byte, 256)
		read, _ := response.Body.Read(body)
		_ = response.Body.Close()

		if response.StatusCode != http.StatusMethodNotAllowed && response.StatusCode != http.StatusNotFound {
			t.Errorf("%s /api/config 状态码 = %d，期望 405 或 404", method, response.StatusCode)
		}
		if got := response.Header.Get("Content-Type"); got != JSONContentType {
			t.Errorf("%s 的 Content-Type = %q，期望 JSON", method, got)
		}
		var envelope struct {
			Ok bool `json:"ok"`
		}
		if err := json.Unmarshal(body[:read], &envelope); err != nil {
			t.Errorf("%s 响应不是 JSON：%s", method, body[:read])
		}
	}
}
