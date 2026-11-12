package icons

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 用假站点构造可直接打两个端点的处理器。
func newTestHandler(t *testing.T) (*Handler, *httptest.Server) {
	t.Helper()

	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head>
				<link rel="apple-touch-icon" href="/touch.png" sizes="180x180">
				<link rel="icon" href="/favicon.ico">
			</head></html>`))
		case "/touch.png":
			writeBytes(w, "image/png", testPNG("touch"))
		case "/favicon.ico":
			writeBytes(w, "image/x-icon", testICO("fav"))
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	t.Cleanup(site.Close)

	return NewHandler(newTestService(t, Options{})), site
}

// 发一次 POST 并解出状态码与响应体。
func postJSON(t *testing.T, handler http.Handler, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	t.Cleanup(func() { _ = response.Body.Close() })

	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("%s 响应不是合法 JSON：%v", path, err)
	}
	return response, payload
}

// Resolve 与 Import 走通：响应字段名必须与前端契约逐字一致。
func TestHandlerResolveThenImport(t *testing.T) {
	handler, site := newTestHandler(t)

	response, body := postJSON(t, handler, ResolvePath, `{"url":"`+site.URL+`"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("Resolve 状态码 = %d，期望 200：%v", response.StatusCode, body)
	}
	if got := response.Header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if ok, _ := body["ok"].(bool); !ok {
		t.Fatalf("ok 应为 true：%v", body)
	}
	if sourceURL, _ := body["sourceUrl"].(string); sourceURL != site.URL {
		t.Fatalf("sourceUrl = %q，期望 %q", sourceURL, site.URL)
	}
	sessionID, _ := body["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("sessionId 不得为空：%v", body)
	}

	candidates, ok := body["candidates"].([]any)
	if !ok || len(candidates) != 2 {
		t.Fatalf("candidates 不符：%v", body["candidates"])
	}
	first, _ := candidates[0].(map[string]any)
	for _, key := range []string{"candidateId", "tier", "contentType", "byteLength", "previewDataUrl", "declaredSizes"} {
		if _, exists := first[key]; !exists {
			t.Fatalf("候选缺少字段 %q：%v", key, first)
		}
	}
	second, _ := candidates[1].(map[string]any)
	if _, exists := second["declaredSizes"]; exists {
		t.Fatalf("未声明尺寸时不应出现 declaredSizes：%v", second)
	}
	if tier, _ := second["tier"].(string); tier != string(TierRelIcon) {
		t.Fatalf("次枚档位 = %q，期望 %q", tier, TierRelIcon)
	}

	candidateID, _ := first["candidateId"].(string)
	importResponse, importBody := postJSON(t, handler, ImportPath,
		`{"sessionId":"`+sessionID+`","candidateId":"`+candidateID+`"}`)
	if importResponse.StatusCode != http.StatusOK {
		t.Fatalf("Import 状态码 = %d，期望 200：%v", importResponse.StatusCode, importBody)
	}
	importedPath, _ := importBody["path"].(string)
	filename, _ := importBody["filename"].(string)
	if !strings.HasPrefix(importedPath, "/images/") || filename == "" {
		t.Fatalf("Import 成功体不符：%v", importBody)
	}
	if importedPath != "/images/"+filename {
		t.Fatalf("path 与 filename 不一致：%v", importBody)
	}
}

// 请求体不是 JSON 一律按 422 配置无效处理，与非 JSON 的认证/方法错误区分。
func TestHandlerRejectsInvalidJSONBody(t *testing.T) {
	handler, _ := newTestHandler(t)

	for _, path := range []string{ResolvePath, ImportPath} {
		response, body := postJSON(t, handler, path, `not json`)
		if response.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("%s 非法请求体状态码 = %d，期望 422：%v", path, response.StatusCode, body)
		}
		errorBody, _ := body["error"].(map[string]any)
		if code, _ := errorBody["code"].(string); code != "CONFIG_INVALID" {
			t.Fatalf("%s 错误码 = %q，期望 CONFIG_INVALID", path, code)
		}
	}
}

// 地址无效与无候选都是 422：这是用户可以自行修正的输入问题。
func TestHandlerMapsInputFailuresTo422(t *testing.T) {
	handler, _ := newTestHandler(t)

	response, body := postJSON(t, handler, ResolvePath, `{"url":"ftp://example.com"}`)
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("无效地址状态码 = %d，期望 422：%v", response.StatusCode, body)
	}

	emptySite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeStatus(w, http.StatusNotFound)
	}))
	defer emptySite.Close()

	response, body = postJSON(t, handler, ResolvePath, `{"url":"`+emptySite.URL+`"}`)
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("无候选状态码 = %d，期望 422：%v", response.StatusCode, body)
	}
	errorBody, _ := body["error"].(map[string]any)
	if code, _ := errorBody["code"].(string); code != "CONFIG_INVALID" {
		t.Fatalf("无候选错误码 = %q，期望 CONFIG_INVALID", code)
	}
}

// 会话与候选缺失映射到 404，提示用户重新获取。
func TestHandlerMapsMissingSessionTo404(t *testing.T) {
	handler, _ := newTestHandler(t)

	response, body := postJSON(t, handler, ImportPath, `{"sessionId":"nope","candidateId":"nope"}`)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("未知会话状态码 = %d，期望 404：%v", response.StatusCode, body)
	}
	errorBody, _ := body["error"].(map[string]any)
	if code, _ := errorBody["code"].(string); code != "NOT_FOUND" {
		t.Fatalf("错误码 = %q，期望 NOT_FOUND", code)
	}

	response, _ = postJSON(t, handler, ImportPath, `{"sessionId":"","candidateId":""}`)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("缺少标识状态码 = %d，期望 404", response.StatusCode)
	}
}

// 超时映射到 504，与其它出站失败区分。
func TestHandlerMapsTimeoutTo504(t *testing.T) {
	release := make(chan struct{})
	slowSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {
		case <-release:
		case <-time.After(2 * time.Second):
		}
		writeStatus(w, http.StatusGatewayTimeout)
	}))
	defer func() {
		close(release)
		slowSite.Close()
	}()

	handler := NewHandler(newTestService(t, Options{FetchTimeout: 30 * time.Millisecond}))
	response, body := postJSON(t, handler, ResolvePath, `{"url":"`+slowSite.URL+`"}`)
	// 全部超时时服务层按「超时且无候选」归类到 422，文案区分于普通无候选
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("超时且无候选状态码 = %d，期望 422：%v", response.StatusCode, body)
	}
	errorBody, _ := body["error"].(map[string]any)
	message, _ := errorBody["message"].(string)
	if message != msgNoCandidatesAfter {
		t.Fatalf("失败文案 = %q，期望 %q", message, msgNoCandidatesAfter)
	}
}

// 写入失败映射到 500，文案指向配置目录权限。
func TestHandlerMapsWriteFailureTo500(t *testing.T) {
	handler, site := newTestHandler(t)

	_, body := postJSON(t, handler, ResolvePath, `{"url":"`+site.URL+`"}`)
	sessionID, _ := body["sessionId"].(string)
	candidates, _ := body["candidates"].([]any)
	first, _ := candidates[0].(map[string]any)
	candidateID, _ := first["candidateId"].(string)

	// 把落点换成必然写入失败的路径：与已有文件同名的目录
	dir := t.TempDir()
	blocker := dir + string(filepath.Separator) + "images"
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("准备落点失败：%v", err)
	}
	handler.service.imagesDir = blocker

	response, failedBody := postJSON(t, handler, ImportPath,
		`{"sessionId":"`+sessionID+`","candidateId":"`+candidateID+`"}`)
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("写入失败状态码 = %d，期望 500：%v", response.StatusCode, failedBody)
	}
	errorBody, _ := failedBody["error"].(map[string]any)
	if code, _ := errorBody["code"].(string); code != "INTERNAL" {
		t.Fatalf("错误码 = %q，期望 INTERNAL", code)
	}
}

// 非 POST 方法与未知子路径都回 JSON 404，不得回退到 SPA。
func TestHandlerRejectsNonPostAndUnknownPaths(t *testing.T) {
	handler, _ := newTestHandler(t)

	request := httptest.NewRequest(http.MethodGet, ResolvePath, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("GET 状态码 = %d，期望 404", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("GET Content-Type = %q，期望 JSON", got)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/icons/unknown", strings.NewReader("{}"))
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("未知子路径状态码 = %d，期望 404", recorder.Code)
	}
}

// 没有注入服务时按内部错误响应，而不是 panic。
func TestHandlerWithoutService(t *testing.T) {
	handler := NewHandler(nil)
	response, body := postJSON(t, handler, ResolvePath, `{"url":"https://example.com"}`)
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，期望 500：%v", response.StatusCode, body)
	}
}

// 错误信封的 ok 必须为 false，方法不受支持时也走同一信封。
func TestHandlerErrorEnvelopeShape(t *testing.T) {
	handler, _ := newTestHandler(t)

	response, body := postJSON(t, handler, ResolvePath, `{"url":"ftp://example.com"}`)
	if response.StatusCode == http.StatusOK {
		t.Fatal("本用例要求失败响应")
	}
	if ok, _ := body["ok"].(bool); ok {
		t.Fatalf("失败信封的 ok 必须为 false：%v", body)
	}
	errorBody, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("失败信封缺少 error 对象：%v", body)
	}
	if message, _ := errorBody["message"].(string); message == "" {
		t.Fatalf("失败信封缺少 message：%v", errorBody)
	}
}
