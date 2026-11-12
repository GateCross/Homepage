package httpx

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// 构造最小产物：入口 HTML、SVG 图标、带哈希的 JS，以及产物根外的敏感文件。
func testDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html":            {Data: []byte("<!doctype html><title>首页</title>")},
		"favicon.svg":           {Data: []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")},
		"assets/app-abc123.js":  {Data: []byte("console.log(1)")},
		"assets/app-abc123.css": {Data: []byte("body{margin:0}")},
		"nested/index.html":     {Data: []byte("<!doctype html><title>子页面</title>")},
		// 位于 dist 之外，任何路径都不允许读到
		"secret.txt": {Data: []byte("不得外泄")},
	}
}

func serve(handler http.HandlerFunc, target string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, target, nil))
	return recorder
}

// 带 .. 的路径一律拒绝，不得读到产物根之外的内容。
func TestServeSPARejectsTraversal(t *testing.T) {
	static := NewStaticForTest(testDist())
	paths := []string{
		"/../secret.txt",
		"/assets/../../secret.txt",
		"/..%2fsecret.txt",
		"/nested/../../secret.txt",
		`/..\secret.txt`,
		"/./../secret.txt",
	}
	for _, target := range paths {
		recorder := serve(static.ServeSPA, target)
		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s 应被拒绝，实际状态码 = %d", target, recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "不得外泄") {
			t.Errorf("%s 泄漏了产物根外的文件", target)
		}
	}
}

// 不含 .. 的普通相对路径仍然可读，穿越校验不能误伤正常请求。
func TestServeSPAAllowsNormalPaths(t *testing.T) {
	static := NewStaticForTest(testDist())
	for _, target := range []string{"/assets/app-abc123.js", "/favicon.svg", "/nested/"} {
		recorder := serve(static.ServeSPA, target)
		if recorder.Code != http.StatusOK {
			t.Errorf("%s 状态码 = %d，期望 200", target, recorder.Code)
		}
	}
}

// SVG 必须按附件下载，并禁用类型嗅探。
func TestServeSVGSetsAttachment(t *testing.T) {
	static := NewStaticForTest(testDist())
	recorder := serve(static.ServeSPA, "/favicon.svg")

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

// 非 SVG 不带附件头，避免正常资源被迫下载。
func TestServeNonSVGHasNoAttachment(t *testing.T) {
	static := NewStaticForTest(testDist())
	recorder := serve(static.ServeSPA, "/assets/app-abc123.js")

	if got := recorder.Header().Get("Content-Disposition"); got != "" {
		t.Fatalf("JS 不应带 Content-Disposition，实际 = %q", got)
	}
}

// 带哈希的 assets 长缓存，入口 HTML 每次回源。
func TestCacheControlByExtension(t *testing.T) {
	static := NewStaticForTest(testDist())

	asset := serve(static.ServeSPA, "/assets/app-abc123.js")
	if got := asset.Header().Get("Cache-Control"); got != immutableCacheControl {
		t.Fatalf("资源 Cache-Control = %q，期望 %q", got, immutableCacheControl)
	}
	// 未命中的深层路由回退到入口 HTML，必须不可长缓存
	fallback := serve(static.ServeSPA, "/deep/unknown/route")
	if got := fallback.Header().Get("Cache-Control"); got != noCacheControl {
		t.Fatalf("回退 HTML 的 Cache-Control = %q，期望 %q", got, noCacheControl)
	}
}

// 未命中回退入口 HTML，且不改变状态码。
func TestServeSPAFallsBackToIndex(t *testing.T) {
	static := NewStaticForTest(testDist())
	recorder := serve(static.ServeSPA, "/dashboard/settings")

	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "<title>首页</title>") {
		t.Fatalf("未回退到入口 HTML：%s", recorder.Body.String())
	}
}

// 产物未就绪时全部返回 404，而不是把空内容当站点。
func TestServeSPANotReadyReturns404(t *testing.T) {
	static := NewStaticForTest(fstest.MapFS{"placeholder.go": {Data: []byte("package webdist")}})
	if static.Ready() {
		t.Fatalf("缺少 index.html 时 Ready() 应为 false")
	}
	recorder := serve(static.ServeSPA, "/")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", recorder.Code)
	}
}

// ServeFile 不做 SPA 回退，未命中直接 404。
func TestServeFileDoesNotFallBack(t *testing.T) {
	static := NewStaticForTest(testDist())
	recorder := serve(static.ServeFile, "/missing.js")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", recorder.Code)
	}
}

func TestCleanRequestPath(t *testing.T) {
	cases := []struct {
		path     string
		expected string
		ok       bool
	}{
		{"/", "", true},
		{"/index.html", "index.html", true},
		{"/assets/app.js", "assets/app.js", true},
		{"//assets//app.js", "assets/app.js", true},
		{"/assets/./app.js", "assets/app.js", true},
		{"/../etc/passwd", "", false},
		{"/assets/../../etc/passwd", "", false},
		{"/..", "", false},
		{`/a\..\b`, "", false},
	}
	for _, testCase := range cases {
		got, ok := cleanRequestPath(testCase.path)
		if ok != testCase.ok || got != testCase.expected {
			t.Errorf("cleanRequestPath(%q) = (%q, %v)，期望 (%q, %v)",
				testCase.path, got, ok, testCase.expected, testCase.ok)
		}
	}
}

// 目录请求与无扩展路径都按目录下的 index.html 处理。
func TestServeDirectoryIndex(t *testing.T) {
	static := NewStaticForTest(testDist())
	recorder := serve(static.ServeSPA, "/nested")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "子页面") {
		t.Fatalf("未返回目录下的入口文件：%s", recorder.Body.String())
	}
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

// 构造同时带产物与配置资产根的托管器。
func newAssetStatic(t *testing.T, configDir string) *Static {
	t.Helper()

	static := NewStaticForTest(testDist())
	static.UseConfigAssets(configDir)
	return static
}

// 两个资产前缀分别命中各自的子目录，并按后缀给 MIME 与长缓存。
func TestServeConfigAsset(t *testing.T) {
	configDir := testConfigDir(t)
	static := newAssetStatic(t, configDir)

	cases := map[string]string{
		"/images/logo.png":   "image/png",
		"/icons/favicon.ico": "image/x-icon",
	}
	for target, expectedType := range cases {
		recorder := serve(static.ServeSPA, target)
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

// 穿越路径一律 404，且不得读到配置根上的 YAML。
func TestServeConfigAssetRejectsTraversal(t *testing.T) {
	configDir := testConfigDir(t)
	static := newAssetStatic(t, configDir)

	paths := []string{
		"/images/../settings.yaml",
		"/images/../../settings.yaml",
		"/images/../images/logo.png",
		"/icons/../settings.yaml",
		"/images/nested/../../settings.yaml",
		`/images\..\settings.yaml`,
		"/images/%2e%2e/settings.yaml",
	}
	for _, target := range paths {
		recorder := serve(static.ServeSPA, target)
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
	configDir := testConfigDir(t)
	static := newAssetStatic(t, configDir)

	// 只在 icons 根下存在的文件，不能经 /images/ 取到
	if recorder := serve(static.ServeSPA, "/images/only-icon.txt"); recorder.Code != http.StatusNotFound {
		t.Fatalf("/images/ 不得读到 icons 根的文件，实际状态码 = %d", recorder.Code)
	}
	// 配置根上的 YAML 更不能经任一前缀取到
	for _, target := range []string{"/images/settings.yaml", "/icons/settings.yaml"} {
		if recorder := serve(static.ServeSPA, target); recorder.Code != http.StatusNotFound {
			t.Fatalf("%s 不得读到配置根上的文件，实际状态码 = %d", target, recorder.Code)
		}
	}
	if recorder := serve(static.ServeSPA, "/icons/only-icon.txt"); recorder.Code != http.StatusOK {
		t.Fatalf("/icons/ 应命中自己的文件，实际状态码 = %d", recorder.Code)
	}
}

// 资产前缀下的缺失文件返回 404，不回退入口 HTML。
func TestServeConfigAssetMissingDoesNotFallBack(t *testing.T) {
	configDir := testConfigDir(t)
	static := newAssetStatic(t, configDir)

	for _, target := range []string{"/images/missing.png", "/icons/missing.ico", "/images/deep/"} {
		recorder := serve(static.ServeSPA, target)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404", target, recorder.Code)
		}
		if strings.Contains(recorder.Body.String(), "<title>首页</title>") {
			t.Fatalf("%s 不得回退到入口 HTML", target)
		}
	}
}

// 资产前缀下的 SVG 按附件下载并禁用嗅探，与产物内的 SVG 同一策略。
func TestServeConfigAssetSVGAttachment(t *testing.T) {
	configDir := testConfigDir(t)
	static := newAssetStatic(t, configDir)

	recorder := serve(static.ServeSPA, "/images/mark.svg")
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

// 未绑定配置目录时两个前缀仍走普通回退，不影响既有部署。
func TestServeConfigAssetWithoutConfigDir(t *testing.T) {
	static := NewStaticForTest(testDist())
	static.UseConfigAssets("")

	for _, target := range []string{"/images/logo.png", "/icons/favicon.ico"} {
		recorder := serve(static.ServeSPA, target)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s 状态码 = %d，期望回退到 200", target, recorder.Code)
		}
		if !strings.Contains(recorder.Body.String(), "<title>首页</title>") {
			t.Fatalf("%s 未回退到入口 HTML", target)
		}
	}
}

// 目录请求取该目录下的 index.html；目录内没有入口文件时同样是 404。
func TestServeConfigAssetDirectoryIndex(t *testing.T) {
	configDir := testConfigDir(t)
	static := newAssetStatic(t, configDir)

	rootIndex := serve(static.ServeSPA, "/images/")
	if rootIndex.Code != http.StatusOK {
		t.Fatalf("资产根目录有 index.html 时应返回 200，实际 = %d", rootIndex.Code)
	}
	if !strings.Contains(rootIndex.Body.String(), "图片目录首页") {
		t.Fatalf("未返回资产根下的入口文件：%s", rootIndex.Body.String())
	}

	// 目录存在但没有 index.html，不得回退到站点入口
	missing := serve(static.ServeSPA, "/images/nested")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("目录无 index.html 时应 404，实际 = %d", missing.Code)
	}
}
