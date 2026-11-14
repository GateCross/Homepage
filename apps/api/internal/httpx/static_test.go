package httpx

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 搭建带真实路由的测试环境：生产中 Assets 经 ServeMux 的 /images/ /icons/ 模式挂载，
// 段级解码与清洗发生在 mux，测试必须走同一条路径。
func newAssetFixture(t *testing.T, files map[string]string) *httptest.Server {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		absolute := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatalf("创建目录失败：%v", err)
		}
		if err := os.WriteFile(absolute, []byte(content), 0o644); err != nil {
			t.Fatalf("写入资产失败：%v", err)
		}
	}

	mux := http.NewServeMux()
	assets := NewAssets(root)
	mux.Handle("/images/", assets)
	mux.Handle("/icons/", assets)
	mux.Handle("/", http.NotFoundHandler())
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func getAsset(t *testing.T, server *httptest.Server, path string) *http.Response {
	t.Helper()
	response, err := http.Get(server.URL + path)
	if err != nil {
		t.Fatalf("请求 %s 失败：%v", path, err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

// 存在的文件按长期缓存提供，并带嗅探防护与 Vary。
func TestAssetsServesFile(t *testing.T) {
	server := newAssetFixture(t, map[string]string{
		"images/logo.png": "png-bytes",
	})
	response := getAsset(t, server, "/images/logo.png")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", response.StatusCode)
	}
	if got := response.Header.Get("Cache-Control"); got != immutableCacheControl {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := response.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := response.Header.Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Fatalf("Vary = %q，应含 Accept-Encoding", got)
	}
}

// 缺失文件 404，不回退 HTML；裸前缀同样 404。
func TestAssetsMissingFileNotFound(t *testing.T) {
	server := newAssetFixture(t, map[string]string{
		"images/logo.png": "png-bytes",
	})
	for _, path := range []string{"/images/missing.png", "/images", "/icons/missing.ico", "/images/sub/missing.png"} {
		response := getAsset(t, server, path)
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404", path, response.StatusCode)
		}
	}
}

// 目录不提供列表：无 index.html 的目录与资产根本身都按不存在处理。
func TestAssetsDirectoryWithoutIndexNotFound(t *testing.T) {
	server := newAssetFixture(t, map[string]string{
		"images/logo.png": "png-bytes",
	})
	for _, path := range []string{"/images/", "/images/nested/"} {
		response := getAsset(t, server, path)
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404（目录不提供列表）", path, response.StatusCode)
		}
	}
}

// 目录存在 index.html 时按该文件提供。
func TestAssetsDirectoryWithIndex(t *testing.T) {
	server := newAssetFixture(t, map[string]string{
		"icons/index.html": "<!doctype html>",
	})
	response := getAsset(t, server, "/icons/")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); !strings.Contains(got, "text/html") {
		t.Fatalf("Content-Type = %q，期望 HTML", got)
	}
}

// 路径穿越一律拒绝：字面 .. 与解码变形都拿不到资产根之外的文件。
func TestAssetsRejectsTraversal(t *testing.T) {
	// 资产根的同级放一份秘密文件，任何形态的穿越都不应读到
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(filepath.Dir(root), "secret.yaml"), []byte("token"), 0o600); err != nil {
		t.Fatalf("写入秘密文件失败：%v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/images/", NewAssets(root))
	server := httptest.NewServer(mux)
	defer server.Close()

	for _, path := range []string{"/images/../secret.yaml", "/images/%2e%2e/secret.yaml", "/images/..%2fsecret.yaml"} {
		response := getAsset(t, server, path)
		body := make([]byte, 64)
		n, _ := response.Body.Read(body)
		if response.StatusCode == http.StatusOK || strings.Contains(string(body[:n]), "token") {
			t.Fatalf("%s 不应读到资产根外文件，状态码 %d", path, response.StatusCode)
		}
	}
}

// SVG 按附件下发，避免被当作同源文档执行。
func TestAssetsSVGAttachment(t *testing.T) {
	server := newAssetFixture(t, map[string]string{
		"images/mark.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
	})
	response := getAsset(t, server, "/images/mark.svg")
	if got := response.Header.Get("Content-Disposition"); got != "attachment" {
		t.Fatalf("Content-Disposition = %q，期望 attachment", got)
	}
	if got := response.Header.Get("Content-Type"); !strings.Contains(got, "image/svg+xml") {
		t.Fatalf("Content-Type = %q，期望 SVG", got)
	}
}

// HEAD 请求不带响应体但返回头完整。
func TestAssetsHeadRequest(t *testing.T) {
	server := newAssetFixture(t, map[string]string{
		"images/logo.png": "png-bytes",
	})
	response := getAsset(t, server, "/images/logo.png")
	_ = response.Body.Close()
	request, err := http.NewRequest(http.MethodHead, server.URL+"/images/logo.png", nil)
	if err != nil {
		t.Fatalf("构造 HEAD 请求失败：%v", err)
	}
	head, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("HEAD 请求失败：%v", err)
	}
	defer func() { _ = head.Body.Close() }()
	if head.StatusCode != http.StatusOK {
		t.Fatalf("HEAD 状态码 = %d，期望 200", head.StatusCode)
	}
	if length := head.Header.Get("Content-Length"); length == "" {
		t.Fatal("HEAD 响应应带 Content-Length")
	}
}
