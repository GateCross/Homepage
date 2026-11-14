package httpx

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func serve(handler http.HandlerFunc, target string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, target, nil))
	return recorder
}

// 构造配置目录：两个资产根各放一份文件，配置根上放一份不得外泄的 YAML。
func testConfigDir(t *testing.T) string {
	t.Helper()

	dir := t.TempDir()
	for _, sub := range []string{imagesSubdir, iconsSubdir} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatalf("创建 %s 目录失败：%v", sub, err)
		}
	}
	files := map[string][]byte{
		"images/logo.png":       {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00},
		"images/mark.svg":       []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
		"icons/favicon.ico":     {0x00, 0x00, 0x01, 0x00, 0x01, 0x00},
		"settings.yaml":         []byte("title: 不得外泄\n"),
		"icons/only-icon.txt":   []byte("图标根独有"),
		"images/nested/a.png":   {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01},
		"images/index.html":     []byte("<!doctype html><title>图片目录首页</title>"),
		"images/deep/index.txt": []byte("目录下的入口不在 images/index.html"),
	}
	for name, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("创建 %s 的上级目录失败：%v", name, err)
		}
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatalf("写入 %s 失败：%v", name, err)
		}
	}
	return dir
}

// 两个资产前缀分别命中各自的子目录，并按后缀给 MIME 与统一长缓存。
func TestServeConfigAsset(t *testing.T) {
	assets := NewAssets(testConfigDir(t))

	cases := map[string]string{
		"/images/logo.png":   "image/png",
		"/icons/favicon.ico": "image/x-icon",
	}
	for target, expectedType := range cases {
		recorder := serve(assets.Serve, target)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s 状态码 = %d，期望 200", target, recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); got != expectedType {
			t.Fatalf("%s Content-Type = %q，期望 %q", target, got, expectedType)
		}
		if got := recorder.Header().Get("Cache-Control"); got != immutableCacheControl {
			t.Fatalf("%s Cache-Control = %q，期望 %q", target, got, immutableCacheControl)
		}
	}
}

// 非 SVG 资产不带附件头，避免正常图片被迫下载。
func TestServeNonSVGHasNoAttachment(t *testing.T) {
	assets := NewAssets(testConfigDir(t))
	recorder := serve(assets.Serve, "/images/logo.png")

	if got := recorder.Header().Get("Content-Disposition"); got != "" {
		t.Fatalf("PNG 不应带 Content-Disposition，实际 = %q", got)
	}
}

// 穿越路径一律 404，且不得读到配置根上的 YAML。
func TestServeConfigAssetRejectsTraversal(t *testing.T) {
	assets := NewAssets(testConfigDir(t))

	paths := []string{
		"/images/../settings.yaml",
		"/images/../../settings.yaml",
		"/images/../images/logo.png",
		"/icons/../settings.yaml",
		"/images/nested/../../settings.yaml",
		`/images\..\settings.yaml`,
		"/images/%2e%2e/settings.yaml",
		"/images/%2e%2e%2fsettings.yaml",
		"/images/%2e%2e/icons/favicon.ico",
	}
	for _, target := range paths {
		recorder := serve(assets.Serve, target)
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s 应被拒绝，实际状态码 = %d", target, recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "不得外泄") {
			t.Errorf("%s 泄漏了配置根上的文件", target)
		}
	}
}

// 资产根不向另一个子目录借文件：join 根各自独立，不是整个配置目录。
func TestServeConfigAssetKeepsRootsSeparate(t *testing.T) {
	assets := NewAssets(testConfigDir(t))

	// 只在 icons 根下存在的文件，不能经 /images/ 取到
	if recorder := serve(assets.Serve, "/images/only-icon.txt"); recorder.Code != http.StatusNotFound {
		t.Fatalf("/images/ 不得读到 icons 根的文件，实际状态码 = %d", recorder.Code)
	}
	// 配置根上的 YAML 更不能经任一前缀取到
	for _, target := range []string{"/images/settings.yaml", "/icons/settings.yaml"} {
		if recorder := serve(assets.Serve, target); recorder.Code != http.StatusNotFound {
			t.Fatalf("%s 不得读到配置根上的文件，实际状态码 = %d", target, recorder.Code)
		}
	}
	if recorder := serve(assets.Serve, "/icons/only-icon.txt"); recorder.Code != http.StatusOK {
		t.Fatalf("/icons/ 应命中自己的文件，实际状态码 = %d", recorder.Code)
	}
}

// 资产前缀下的缺失文件返回 404，不回退任何 HTML。
func TestServeConfigAssetMissingDoesNotFallBack(t *testing.T) {
	assets := NewAssets(testConfigDir(t))

	for _, target := range []string{"/images/missing.png", "/icons/missing.ico", "/images/deep/"} {
		recorder := serve(assets.Serve, target)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404", target, recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "<!doctype html") {
			t.Fatalf("%s 不得回退到 HTML", target)
		}
	}
}

// 资产前缀下的 SVG 按附件下载并禁用嗅探。
func TestServeConfigAssetSVGAttachment(t *testing.T) {
	assets := NewAssets(testConfigDir(t))

	recorder := serve(assets.Serve, "/images/mark.svg")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Disposition"); got != "attachment" {
		t.Fatalf("SVG 的 Content-Disposition = %q，期望 attachment", got)
	}
	if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q，期望 nosniff", got)
	}
	if got := recorder.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Fatalf("SVG 的 Content-Type = %q", got)
	}
}

// 目录请求取该目录下的 index.html；目录内没有入口文件时同样是 404。
func TestServeConfigAssetDirectoryIndex(t *testing.T) {
	assets := NewAssets(testConfigDir(t))

	rootIndex := serve(assets.Serve, "/images/")
	if rootIndex.Code != http.StatusOK {
		t.Fatalf("资产根目录有 index.html 时应返回 200，实际 = %d", rootIndex.Code)
	}
	if !strings.Contains(rootIndex.Body.String(), "图片目录首页") {
		t.Fatalf("未返回资产根下的入口文件：%s", rootIndex.Body.String())
	}

	// 目录存在但没有 index.html，不得回退到任何站点入口
	missing := serve(assets.Serve, "/images/nested")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("目录无 index.html 时应 404，实际 = %d", missing.Code)
	}
}

// 不落在两个资产前缀下的路径一律 404，资产托管器不承接其它路径。
func TestServeNonAssetPathReturns404(t *testing.T) {
	assets := NewAssets(testConfigDir(t))

	for _, target := range []string{"/", "/index.html", "/assets/app.js", "/images", "/icons", "/imagesx/a.png"} {
		recorder := serve(assets.Serve, target)
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s 状态码 = %d，期望 404", target, recorder.Code)
		}
	}
}

// 配置目录为空时不映射资产根，两个前缀一律 404。
func TestServeConfigAssetWithoutConfigDir(t *testing.T) {
	assets := NewAssets("")

	for _, target := range []string{"/images/logo.png", "/icons/favicon.ico"} {
		recorder := serve(assets.Serve, target)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404", target, recorder.Code)
		}
	}
}
