package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gatecross/homepage/api/internal/httpx"
)

// 构造带入口 HTML 与一个静态资源的最小产物。
func testStatic() *httpx.Static {
	return httpx.NewStaticForTest(fstest.MapFS{
		"index.html":        {Data: []byte("<!doctype html><div id=root></div>")},
		"favicon.svg":       {Data: []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")},
		"assets/app-abc.js": {Data: []byte("console.log(1)")},
	})
}

// 未注册的 /api 路径必须返回 JSON 而不是回退到 SPA 的 HTML。
func TestUnknownAPIReturnsJSON(t *testing.T) {
	server := httptest.NewServer(NewRouter(Options{Static: testStatic()}))
	defer server.Close()

	response, err := http.Get(server.URL + "/api/does-not-exist")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 %d", response.StatusCode, http.StatusNotFound)
	}
	if got := response.Header.Get("Content-Type"); got != JSONContentType {
		t.Fatalf("Content-Type = %q，期望 %q", got, JSONContentType)
	}

	var envelope struct {
		Ok    bool `json:"ok"`
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if envelope.Ok {
		t.Fatalf("错误信封的 ok 必须为 false")
	}
	if envelope.Error.Code != CodeNotFound {
		t.Fatalf("错误码 = %q，期望 %q", envelope.Error.Code, CodeNotFound)
	}
}

// /api 根路径同样按 API 处理。
func TestAPIRootReturnsJSON(t *testing.T) {
	server := httptest.NewServer(NewRouter(Options{Static: testStatic()}))
	defer server.Close()

	response, err := http.Get(server.URL + "/api")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if got := response.Header.Get("Content-Type"); got != JSONContentType {
		t.Fatalf("Content-Type = %q，期望 %q", got, JSONContentType)
	}
}

// 非 API 路径的未知地址回退入口 HTML。
func TestNonAPIPathFallsBackToSPA(t *testing.T) {
	server := httptest.NewServer(NewRouter(Options{Static: testStatic()}))
	defer server.Close()

	response, err := http.Get(server.URL + "/some/deep/route")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 %d", response.StatusCode, http.StatusOK)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("入口 HTML 的 Cache-Control = %q，期望 no-cache", got)
	}
	body := make([]byte, 64)
	read, _ := response.Body.Read(body)
	if !strings.Contains(string(body[:read]), "<div id=root>") {
		t.Fatalf("未回退到入口 HTML：%s", body[:read])
	}
}

// 命中真实产物文件时按扩展名给 MIME 与长缓存。
func TestServeExistingAsset(t *testing.T) {
	server := httptest.NewServer(NewRouter(Options{Static: testStatic()}))
	defer server.Close()

	response, err := http.Get(server.URL + "/assets/app-abc.js")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 %d", response.StatusCode, http.StatusOK)
	}
	if got := response.Header.Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := response.Header.Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("带哈希资源的 Cache-Control = %q", got)
	}
}

// /api 之外的未知后缀仍走 SPA，不受 API 命名空间影响。
func TestVersionEndpoint(t *testing.T) {
	// 用桩替换远端检查，避免单元测试真的打 GitHub；远端同版本时不应标记更新
	restoreVersionCheck(t, newStubbedChecker(releaseTransport("v"+Version, "https://example.com/r"), time.Now))
	server := httptest.NewServer(NewRouter(Options{Static: testStatic()}))
	defer server.Close()

	response, err := http.Get(server.URL + "/api/version")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 %d", response.StatusCode, http.StatusOK)
	}
	var body struct {
		Ok              bool   `json:"ok"`
		Version         string `json:"version"`
		UpdateAvailable bool   `json:"updateAvailable"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if !body.Ok {
		t.Fatalf("版本接口的 ok 必须为 true")
	}
	if body.Version == "" {
		t.Fatalf("版本号不得为空")
	}
	if body.UpdateAvailable {
		t.Fatalf("远端返回非版本号时 updateAvailable 必须为 false")
	}
}

// 注入的挂载点接管对应前缀，未注入前缀仍是 JSON 404。
func TestMountsAreInjectable(t *testing.T) {
	docker := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "results": []any{}})
	})
	server := httptest.NewServer(NewRouter(Options{Mounts: Mounts{Docker: docker}, Static: testStatic()}))
	defer server.Close()

	response, err := http.Get(server.URL + "/api/docker/status")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("已挂载的 docker 路径状态码 = %d，期望 200", response.StatusCode)
	}

	configResponse, err := http.Get(server.URL + "/api/config")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = configResponse.Body.Close() }()
	if configResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("未挂载的 config 路径状态码 = %d，期望 404", configResponse.StatusCode)
	}
	if got := configResponse.Header.Get("Content-Type"); got != JSONContentType {
		t.Fatalf("未挂载前缀的 Content-Type = %q，期望 JSON", got)
	}
}

// panic 从路由层穿出时同样被兜住，且升级为 500 信封。
func TestRouterRecoversPanic(t *testing.T) {
	router := NewRouter(Options{
		Mounts: Mounts{Config: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("配置写回失败")
		})},
		Static: testStatic(),
	})
	server := httptest.NewServer(router)
	defer server.Close()

	response, err := http.Get(server.URL + "/api/config")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，期望 %d", response.StatusCode, http.StatusInternalServerError)
	}
	if got := response.Header.Get("Content-Type"); got != JSONContentType {
		t.Fatalf("Content-Type = %q，期望 %q", got, JSONContentType)
	}
}

func TestIsAPIPath(t *testing.T) {
	cases := map[string]bool{
		"/api":           true,
		"/api/":          true,
		"/api/version":   true,
		"/apix":          false,
		"/apifoo/bar":    false,
		"/":              false,
		"/assets/app.js": false,
	}
	for path, expected := range cases {
		if got := isAPIPath(path); got != expected {
			t.Errorf("isAPIPath(%q) = %v，期望 %v", path, got, expected)
		}
	}
}
