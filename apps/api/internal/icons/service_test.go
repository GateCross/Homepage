package icons

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 记录假站点收到的请求，用来断言出网范围与匿名性。
type requestLog struct {
	paths []string
}

// 带 apple-touch-icon 的页面：候选按回退链排列，Import 能落盘并返回 /images 路径。
func TestResolvePageWithAppleTouchIcon(t *testing.T) {
	pngBytes := testPNG("apple-touch")
	icoBytes := testICO("favicon")
	log := &requestLog{}

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.paths = append(log.paths, r.URL.Path)
		if r.Header.Get("Cookie") != "" {
			t.Errorf("取图请求不得携带 Cookie，实得 %q", r.Header.Get("Cookie"))
		}
		switch r.URL.Path {
		case "/dashboard":
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head>
				<link rel="icon" href="/static/favicon.ico" type="image/x-icon">
				<link rel="apple-touch-icon" href="/static/touch.png" sizes="180x180">
			</head><body>dashboard</body></html>`))
		case "/static/touch.png":
			writeBytes(w, "image/png", pngBytes)
		case "/static/favicon.ico":
			writeBytes(w, "image/x-icon", icoBytes)
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	service := newTestService(t, Options{})
	resolved, failure := service.Resolve(context.Background(), server.URL+"/dashboard")
	if failure != nil {
		t.Fatalf("解析应成功，实得失败 %+v", failure)
	}
	if !resolved.Ok || resolved.SourceURL != server.URL+"/dashboard" || resolved.SessionID == "" {
		t.Fatalf("解析成功体不完整：%+v", resolved)
	}
	if len(resolved.Candidates) != 2 {
		t.Fatalf("候选数 = %d，期望 2（页面两枚声明，静态回退都 404）", len(resolved.Candidates))
	}
	if resolved.Candidates[0].Tier != TierAppleTouchIcon || resolved.Candidates[1].Tier != TierRelIcon {
		t.Fatalf("候选档位顺序不符：%q %q", resolved.Candidates[0].Tier, resolved.Candidates[1].Tier)
	}

	first := resolved.Candidates[0]
	if first.ContentType != "image/png" || first.ByteLength != len(pngBytes) {
		t.Fatalf("首枚候选元数据不符：%+v", first)
	}
	if first.DeclaredSizes != "180x180" {
		t.Fatalf("声明尺寸未透传：%+v", first)
	}
	if !strings.HasPrefix(first.PreviewDataURL, "data:image/png;base64,") {
		t.Fatalf("预览应为 PNG data URL：%s", first.PreviewDataURL)
	}
	if first.CandidateID == "" || first.CandidateID == resolved.Candidates[1].CandidateID {
		t.Fatalf("候选标识应非空且互不相同：%+v", resolved.Candidates)
	}

	imported, failure := service.Import(resolved.SessionID, first.CandidateID)
	if failure != nil {
		t.Fatalf("导入应成功，实得失败 %+v", failure)
	}
	if !imported.Ok || !strings.HasPrefix(imported.Path, "/images/") {
		t.Fatalf("导入成功体不符：%+v", imported)
	}
	if !strings.HasPrefix(imported.Filename, "127.0.0.1-") || !strings.HasSuffix(imported.Filename, ".png") {
		t.Fatalf("文件名应为「主机名-时间戳-随机值.扩展名」：%s", imported.Filename)
	}
	written, err := os.ReadFile(filepath.Join(service.imagesDir, imported.Filename))
	if err != nil {
		t.Fatalf("读取落盘文件失败：%v", err)
	}
	if string(written) != string(pngBytes) {
		t.Fatalf("落盘字节与候选不一致：%d 字节", len(written))
	}
	if _, err := os.Stat(service.imagesDir); err != nil {
		t.Fatalf("images 目录应已创建：%v", err)
	}
}

// 只有 favicon 的页面：页面不声明图标，只能靠 origin 级静态回退命中 /favicon.ico。
func TestResolvePageWithOnlyFavicon(t *testing.T) {
	icoBytes := testICO("only-favicon")

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head><title>无图标声明</title></head><body></body></html>`))
		case "/favicon.ico":
			writeBytes(w, "image/x-icon", icoBytes)
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	service := newTestService(t, Options{})
	resolved, failure := service.Resolve(context.Background(), server.URL)
	if failure != nil {
		t.Fatalf("解析应成功，实得失败 %+v", failure)
	}
	if len(resolved.Candidates) != 1 {
		t.Fatalf("候选数 = %d，期望 1", len(resolved.Candidates))
	}
	candidate := resolved.Candidates[0]
	if candidate.Tier != TierStaticFavicon {
		t.Fatalf("档位 = %q，期望 %q", candidate.Tier, TierStaticFavicon)
	}
	if candidate.ContentType != "image/x-icon" {
		t.Fatalf("Content-Type = %q，期望 image/x-icon", candidate.ContentType)
	}
	if candidate.DeclaredSizes != "" || candidate.DeclaredType != "" {
		t.Fatalf("静态回退不应带声明元数据：%+v", candidate)
	}
}

// 跨 host 重定向被拒：页面跳到别的主机即抓取失败，静态回退也不得跟随到该主机。
func TestResolveRejectsCrossHostRedirect(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeBytes(w, "image/png", testPNG("cross"))
	}))
	defer other.Close()

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusFound)
	}))
	defer server.Close()

	service := newTestService(t, Options{})
	_, failure := service.Resolve(context.Background(), server.URL+"/dashboard")
	if failure == nil {
		t.Fatal("跨 host 重定向应导致解析失败")
	}
	// 页面与两枚静态回退全部跨 host，一枚候选都拿不到
	if failure.Code != CodeNoCandidates {
		t.Fatalf("失败分类 = %q，期望 %q", failure.Code, CodeNoCandidates)
	}
}

// 页面超时仍尝试静态回退；全部失败时按超时给出提示文案。
func TestResolveTimeout(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		writeBytes(w, "text/html; charset=utf-8", []byte(`<html></html>`))
	}))
	defer server.Close()

	service := newTestService(t, Options{FetchTimeout: 40 * time.Millisecond})
	_, failure := service.Resolve(context.Background(), server.URL)
	if failure == nil {
		t.Fatal("全部请求超时时解析必须失败")
	}
	if failure.Code != CodeNoCandidates {
		t.Fatalf("失败分类 = %q，期望 %q", failure.Code, CodeNoCandidates)
	}
	if failure.Message != msgNoCandidatesAfter {
		t.Fatalf("超时文案 = %q，期望 %q", failure.Message, msgNoCandidatesAfter)
	}
}

// 非图片内容被丢弃：声明与静态回退都返回 HTML 时，一枚候选都不保留。
func TestResolveDropsNonImageContent(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head>
				<link rel="apple-touch-icon" href="/not-an-image.png">
			</head></html>`))
			return
		}
		// 声称是图片实际是 HTML，登录墙的常见形态
		writeBytes(w, "image/png", []byte("<!doctype html><html><body>请先登录</body></html>"))
	}))
	defer server.Close()

	service := newTestService(t, Options{})
	_, failure := service.Resolve(context.Background(), server.URL)
	if failure == nil {
		t.Fatal("没有合法图片时解析必须失败")
	}
	if failure.Code != CodeNoCandidates {
		t.Fatalf("失败分类 = %q，期望 %q", failure.Code, CodeNoCandidates)
	}
	if failure.Message != msgNoCandidates {
		t.Fatalf("失败文案 = %q，期望 %q", failure.Message, msgNoCandidates)
	}
	// 候选全部被丢弃，会话不应被建立
	if service.store.size() != 0 {
		t.Fatalf("无候选时不得建立会话，实得 %d 个", service.store.size())
	}
}

// 会话过期后 Import 必须失败，并要求重新 Resolve。
func TestImportFailsAfterSessionExpired(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head>
				<link rel="icon" href="/favicon.png">
			</head></html>`))
		case "/favicon.png":
			writeBytes(w, "image/png", testPNG("expiring"))
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	service := newTestService(t, Options{SessionTTL: 40 * time.Millisecond})
	resolved, failure := service.Resolve(context.Background(), server.URL)
	if failure != nil {
		t.Fatalf("解析应成功，实得失败 %+v", failure)
	}
	candidateID := resolved.Candidates[0].CandidateID

	time.Sleep(80 * time.Millisecond)

	_, importFailure := service.Import(resolved.SessionID, candidateID)
	if importFailure == nil {
		t.Fatal("会话过期后导入必须失败")
	}
	if importFailure.Code != CodeSessionExpired {
		t.Fatalf("失败分类 = %q，期望 %q", importFailure.Code, CodeSessionExpired)
	}
	if importFailure.Message != msgSessionExpired {
		t.Fatalf("失败文案 = %q，期望 %q", importFailure.Message, msgSessionExpired)
	}
}

// 地址非法、候选缺失与标识缺失各自给出契约内的失败分类。
func TestResolveAndImportRejectInvalidInput(t *testing.T) {
	service := newTestService(t, Options{})

	for _, rawURL := range []string{"", "   ", "ftp://example.com/icon.png", "not a url", "https://user:pass@example.com"} {
		_, failure := service.Resolve(context.Background(), rawURL)
		if failure == nil || failure.Code != CodeInvalidURL {
			t.Fatalf("%q 应按无效地址失败，实得 %+v", rawURL, failure)
		}
	}

	if _, failure := service.Import("", "cand"); failure == nil || failure.Code != CodeCandidateMissing {
		t.Fatalf("缺少会话标识应按候选缺失失败，实得 %+v", failure)
	}
	if _, failure := service.Import("session", "  "); failure == nil || failure.Code != CodeCandidateMissing {
		t.Fatalf("缺少候选标识应按候选缺失失败，实得 %+v", failure)
	}
	if _, failure := service.Import("session-missing", "cand-missing"); failure == nil || failure.Code != CodeSessionExpired {
		t.Fatalf("不存在的会话应按会话过期失败，实得 %+v", failure)
	}
}

// 会话内不存在的候选按候选缺失失败，而不是会话过期。
func TestImportRejectsUnknownCandidate(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head><link rel="icon" href="/favicon.png"></head></html>`))
		case "/favicon.png":
			writeBytes(w, "image/png", testPNG("known"))
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	service := newTestService(t, Options{})
	resolved, failure := service.Resolve(context.Background(), server.URL)
	if failure != nil {
		t.Fatalf("解析应成功，实得失败 %+v", failure)
	}

	_, importFailure := service.Import(resolved.SessionID, "cand-not-there")
	if importFailure == nil || importFailure.Code != CodeCandidateMissing {
		t.Fatalf("未知候选应按候选缺失失败，实得 %+v", importFailure)
	}
}

// 页面 HTML 超过上限时按抓取失败处理，但静态回退仍可命中。
func TestResolveFallsBackWhenHTMLTooLarge(t *testing.T) {
	icoBytes := testICO("fallback")
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head>
				<link rel="apple-touch-icon" href="/never.png">
			</head><body>`+strings.Repeat("x", 8192)+`</body></html>`))
		case "/favicon.ico":
			writeBytes(w, "image/x-icon", icoBytes)
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	service := newTestService(t, Options{HTMLMaxBytes: 4096})
	resolved, failure := service.Resolve(context.Background(), server.URL)
	if failure != nil {
		t.Fatalf("静态回退应成功，实得失败 %+v", failure)
	}
	if len(resolved.Candidates) != 1 || resolved.Candidates[0].Tier != TierStaticFavicon {
		t.Fatalf("应只剩静态 favicon 候选：%+v", resolved.Candidates)
	}
}

// 候选下载上限生效：页面声明多张图片时最多保留约定数量。
func TestResolveCapsCandidates(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			var builder strings.Builder
			builder.WriteString("<html><head>")
			for index := 0; index < 6; index++ {
				builder.WriteString(`<link rel="icon" href="/icon-` + string(rune('a'+index)) + `.png">`)
			}
			builder.WriteString("</head></html>")
			writeBytes(w, "text/html; charset=utf-8", []byte(builder.String()))
			return
		}
		writeBytes(w, "image/png", testPNG(r.URL.Path))
	}))
	defer server.Close()

	service := newTestService(t, Options{MaxCandidates: 3})
	resolved, failure := service.Resolve(context.Background(), server.URL)
	if failure != nil {
		t.Fatalf("解析应成功，实得失败 %+v", failure)
	}
	if len(resolved.Candidates) != 3 {
		t.Fatalf("候选数 = %d，期望上限 3", len(resolved.Candidates))
	}
}

// 页面的绝对外链不得牵引服务端访问别的主机：跨 host 的声明被跳过，只保留同源候选。
func TestResolveSkipsForeignHostCandidateRefs(t *testing.T) {
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeBytes(w, "image/png", testPNG("foreign"))
	}))
	defer foreign.Close()

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			writeBytes(w, "text/html; charset=utf-8", []byte(`<html><head>
				<link rel="apple-touch-icon" href="`+foreign.URL+`/foreign.png">
				<link rel="icon" href="/local.png">
			</head></html>`))
		case "/local.png":
			writeBytes(w, "image/png", testPNG("local"))
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	service := newTestService(t, Options{})
	resolved, failure := service.Resolve(context.Background(), server.URL)
	if failure != nil {
		t.Fatalf("解析应成功，实得失败 %+v", failure)
	}
	if len(resolved.Candidates) != 1 {
		t.Fatalf("候选数 = %d，期望只保留同源 1 枚", len(resolved.Candidates))
	}
	if resolved.Candidates[0].Tier != TierRelIcon {
		t.Fatalf("保留候选的档位 = %q，期望 %q", resolved.Candidates[0].Tier, TierRelIcon)
	}
}
