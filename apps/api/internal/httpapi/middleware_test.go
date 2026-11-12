package httpapi

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 构造指定内容类型的 JSON 响应，长度由 repeat 控制。
func jsonHandler(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", JSONContentType)
		_, _ = io.WriteString(w, body)
	})
}

// 解压响应体；未压缩时原样返回。
func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer func() { _ = response.Body.Close() }()

	if response.Header.Get("Content-Encoding") != "gzip" {
		payload, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("读取响应体失败：%v", err)
		}
		return string(payload)
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatalf("解压响应体失败：%v", err)
	}
	defer func() { _ = reader.Close() }()
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("读取解压内容失败：%v", err)
	}
	return string(payload)
}

func TestGzipCompressesLargeJSON(t *testing.T) {
	body := `{"ok":true,"data":"` + strings.Repeat("静", 2000) + `"}`
	server := httptest.NewServer(Gzip(jsonHandler(body)))
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	request.Header.Set("Accept-Encoding", "gzip")

	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if got := response.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("大 JSON 应被压缩，Content-Encoding = %q", got)
	}
	if got := readBody(t, response); got != body {
		t.Fatalf("解压后内容与原文不一致，长度 %d 期望 %d", len(got), len(body))
	}
}

func TestGzipSkipsSmallJSON(t *testing.T) {
	body := `{"ok":true}`
	server := httptest.NewServer(Gzip(jsonHandler(body)))
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	request.Header.Set("Accept-Encoding", "gzip")

	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("小于 %d 字节的响应不应压缩，Content-Encoding = %q", gzipMinBytes, got)
	}
	if got := readBody(t, response); got != body {
		t.Fatalf("响应体被改动：%q", got)
	}
}

func TestGzipSkipsNDJSON(t *testing.T) {
	// 每行都超过阈值，确保压缩判定不是被体积挡下的
	line := `{"container":"` + strings.Repeat("a", 600) + `"}`
	var lines []string
	for i := 0; i < 4; i++ {
		lines = append(lines, line)
	}
	body := strings.Join(lines, "\n") + "\n"

	server := httptest.NewServer(Gzip(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.WriteString(w, body)
	})))
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	request.Header.Set("Accept-Encoding", "gzip")

	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("流式响应不得压缩，Content-Encoding = %q", got)
	}
	if got := readBody(t, response); got != body {
		t.Fatalf("流式响应体被改动，长度 %d 期望 %d", len(got), len(body))
	}
}

// 客户端不支持 gzip 时无论体积多大都不压缩。
func TestGzipSkipsWithoutAcceptEncoding(t *testing.T) {
	body := `{"ok":true,"data":"` + strings.Repeat("x", 2000) + `"}`
	server := httptest.NewServer(Gzip(jsonHandler(body)))
	defer server.Close()

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("未声明 gzip 的客户端不应收到压缩体，Content-Encoding = %q", got)
	}
	if got := readBody(t, response); got != body {
		t.Fatalf("响应体被改动，长度 %d 期望 %d", len(got), len(body))
	}
}

// 非 200 状态码与响应头一起原样透出，不得被压缩路径改写。
func TestGzipPreservesErrorStatus(t *testing.T) {
	server := httptest.NewServer(Gzip(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, NotFound("未找到请求的 API 接口"))
	})))
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	request.Header.Set("Accept-Encoding", "gzip")

	response, err := http.DefaultTransport.RoundTrip(request)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 %d", response.StatusCode, http.StatusNotFound)
	}
	if got := response.Header.Get("Content-Type"); got != JSONContentType {
		t.Fatalf("Content-Type = %q，期望 %q", got, JSONContentType)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(readBody(t, response)), &envelope); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if ok, _ := envelope["ok"].(bool); ok {
		t.Fatalf("错误信封的 ok 必须为 false")
	}
}

func TestAcceptsGzip(t *testing.T) {
	cases := map[string]bool{
		"":                    false,
		"gzip":                true,
		"GZIP":                true,
		"deflate, gzip":       true,
		"gzip;q=0":            false,
		"gzip; q=0.0":         false,
		"gzip;q=0.5":          true,
		"br, deflate":         false,
		"identity":            false,
		"gzip;q=0, deflate":   false,
		"deflate, gzip;q=0.8": true,
	}
	for header, expected := range cases {
		if got := acceptsGzip(header); got != expected {
			t.Errorf("acceptsGzip(%q) = %v，期望 %v", header, got, expected)
		}
	}
}

// panic 被吞下并转成 500 信封，堆栈不进响应体。
func TestRecoverPanicsReturnsEnvelope(t *testing.T) {
	server := httptest.NewServer(RecoverPanics(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("内部细节：连接串 postgres://user:secret@host")
	})))
	defer server.Close()

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，期望 %d", response.StatusCode, http.StatusInternalServerError)
	}
	body := readBody(t, response)
	if strings.Contains(body, "secret") || strings.Contains(body, "goroutine") {
		t.Fatalf("响应体泄漏了内部细节：%s", body)
	}
	var envelope struct {
		Ok    bool `json:"ok"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatalf("响应不是合法 JSON 信封：%v", err)
	}
	if envelope.Ok || envelope.Error.Message == "" {
		t.Fatalf("信封缺少 ok=false 或错误文案：%s", body)
	}
}

// 响应已经开始写出后再 panic，不得补写 500 信封造成状态行重复。
func TestRecoverPanicsKeepsCommittedResponse(t *testing.T) {
	server := httptest.NewServer(RecoverPanics(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", JSONContentType)
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"ok":true}`)
		panic("写出之后才失败")
	})))
	defer server.Close()

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("状态码 = %d，期望保留已写出的 %d", response.StatusCode, http.StatusAccepted)
	}
	if got := readBody(t, response); got != `{"ok":true}` {
		t.Fatalf("响应体被改写：%q", got)
	}
}
