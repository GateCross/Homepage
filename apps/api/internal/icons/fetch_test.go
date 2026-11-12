package icons

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 页面里的 apple-touch 声明落在第一档，且相对路径要解析成绝对地址。
func TestDiscoverIconRefs(t *testing.T) {
	html := `<html><head>
		<link rel="stylesheet" href="/app.css">
		<link rel="icon" href="/favicon.png" sizes="32x32">
		<link rel="apple-touch-icon-precomposed" href="/touch.png" sizes="180x180">
		<link rel="shortcut icon" type="image/x-icon" href="//cdn.example.com/fav.ico">
		<link rel="apple-touch-icon" href="https://other.example.com/touch2.png">
	</head></html>`

	refs := discoverIconRefs(html, "https://example.com/docs/page")

	if len(refs) != 4 {
		t.Fatalf("候选引用数 = %d，期望 4（stylesheet 不收，其余四条都收）", len(refs))
	}
	if refs[0].tier != TierAppleTouchIcon || refs[0].href != "https://example.com/touch.png" {
		t.Fatalf("第 1 档应先按文档序取 apple-touch 声明，实得 %+v", refs[0])
	}
	if refs[0].declaredSizes != "180x180" {
		t.Fatalf("声明尺寸未保留：%+v", refs[0])
	}
	if refs[1].tier != TierAppleTouchIcon || refs[1].href != "https://other.example.com/touch2.png" {
		t.Fatalf("同档第 2 条应为绝对地址的 apple-touch 声明，实得 %+v", refs[1])
	}
	if refs[2].tier != TierRelIcon || refs[2].href != "https://example.com/favicon.png" {
		t.Fatalf("apple-touch 之后才是 rel=icon 声明，实得 %+v", refs[2])
	}
	if refs[2].declaredSizes != "32x32" {
		t.Fatalf("rel=icon 的声明尺寸未保留：%+v", refs[2])
	}
	if refs[3].tier != TierRelIcon || refs[3].href != "https://cdn.example.com/fav.ico" {
		t.Fatalf("协议相对地址应解析成同协议绝对地址，实得 %+v", refs[3])
	}
	if refs[3].declaredType != "image/x-icon" {
		t.Fatalf("声明类型未保留：%+v", refs[3])
	}
}

// 合并时静态回退排在页面声明之后，并按 href 去重保留先出现的一条。
func TestMergeIconDiscoveryDedupesAndAppendsStatic(t *testing.T) {
	fromHTML := []iconRef{
		{href: "https://example.com/favicon.ico", tier: TierRelIcon},
		{href: "https://example.com/touch.png", tier: TierAppleTouchIcon},
	}

	merged := mergeIconDiscovery(fromHTML, "https://example.com/page")

	if len(merged) != 3 {
		t.Fatalf("合并后条数 = %d，期望 3（两条声明 + 一条静态回退）", len(merged))
	}
	if merged[0].tier != TierRelIcon {
		t.Fatalf("首条应保留页面声明与去重前的档位，实得 %+v", merged[0])
	}
	if merged[1].tier != TierAppleTouchIcon || merged[1].href != "https://example.com/touch.png" {
		t.Fatalf("第 2 条不符：%+v", merged[1])
	}
	if merged[2].tier != TierStaticAppleTouch || merged[2].href != "https://example.com/apple-touch-icon.png" {
		t.Fatalf("静态回退应只剩未出现的 origin 级 apple-touch，实得 %+v", merged[2])
	}
}

// 静态回退按约定的先后顺序给出两条 origin 级路径。
func TestStaticFallbackRefs(t *testing.T) {
	refs := staticFallbackRefs("https://example.com:8443/deep/page?x=1")

	if len(refs) != 2 {
		t.Fatalf("静态回退条数 = %d，期望 2", len(refs))
	}
	if refs[0].href != "https://example.com:8443/apple-touch-icon.png" || refs[0].tier != TierStaticAppleTouch {
		t.Fatalf("首条应为 origin 级 apple-touch，实得 %+v", refs[0])
	}
	if refs[1].href != "https://example.com:8443/favicon.ico" || refs[1].tier != TierStaticFavicon {
		t.Fatalf("次条应为 origin 级 favicon，实得 %+v", refs[1])
	}
}

// 跨主机、跨协议与跨端口都不算同源。
func TestIsSameOrigin(t *testing.T) {
	cases := []struct {
		from  string
		to    string
		same  bool
		label string
	}{
		{"https://example.com/a", "https://example.com/b", true, "同主机同协议"},
		{"https://example.com:443/a", "https://example.com/b", true, "默认端口等价"},
		{"https://example.com/a", "https://cdn.example.com/a", false, "跨主机"},
		{"https://example.com/a", "http://example.com/a", false, "跨协议"},
		{"https://example.com/a", "https://example.com:8443/a", false, "同主机跨端口"},
		{"https://example.com/a", "https://example.com.evil.com/a", false, "后缀伪装"},
	}
	for _, testCase := range cases {
		if got := isSameOrigin(testCase.from, testCase.to); got != testCase.same {
			t.Fatalf("%s：同源判定 = %v，期望 %v", testCase.label, got, testCase.same)
		}
	}
}

// 魔法头识别覆盖支持的六种格式，非图片内容必须被拒。
func TestDetectImageExt(t *testing.T) {
	cases := []struct {
		body []byte
		ext  ImageExt
		ok   bool
	}{
		{testPNG("x"), ExtPNG, true},
		{testICO("x"), ExtICO, true},
		{[]byte{0xff, 0xd8, 0xff, 0xe0, 0x00}, ExtJPEG, true},
		{[]byte("GIF89a...."), ExtGIF, true},
		{[]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), ExtWebP, true},
		{[]byte("\n  <svg xmlns='http://www.w3.org/2000/svg'></svg>"), ExtSVG, true},
		{[]byte("<html><body>not an image</body></html>"), "", false},
		{[]byte("{}"), "", false},
		{[]byte{}, "", false},
	}
	for _, testCase := range cases {
		ext, ok := detectImageExt(testCase.body)
		if ok != testCase.ok || ext != testCase.ext {
			t.Fatalf("%q 识别结果 = (%q, %v)，期望 (%q, %v)", testCase.body, ext, ok, testCase.ext, testCase.ok)
		}
	}
}

// 预览 data URL 的 MIME 必须与识别出的扩展名对应。
func TestBytesToDataURL(t *testing.T) {
	got := bytesToDataURL(testPNG("x"), ExtPNG)
	if !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Fatalf("data URL 前缀不符：%s", got)
	}
	if bytesToDataURL([]byte{0x01}, ExtICO) != "data:image/x-icon;base64,AQ==" {
		t.Fatalf("ICO 的 MIME 或编码不符：%s", bytesToDataURL([]byte{0x01}, ExtICO))
	}
}

// 只跟随同源跳转，且跳转次数用尽即失败。
func TestFetchResourceFollowsSameOriginRedirects(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start":
			http.Redirect(w, r, "/middle", http.StatusFound)
		case "/middle":
			http.Redirect(w, r, server.URL+"/final", http.StatusMovedPermanently)
		case "/final":
			writeBytes(w, "image/png", testPNG("final"))
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	result, failure := fetchResource(context.Background(), client, server.URL+"/start", fetchOptions{
		timeout:      5 * time.Second,
		maxBytes:     ImageMaxBytes,
		maxRedirects: MaxRedirects,
	})
	if failure != nil {
		t.Fatalf("同源跳转应成功，实得失败 %+v", failure)
	}
	if result.url != server.URL+"/final" {
		t.Fatalf("最终地址 = %q，期望 %q", result.url, server.URL+"/final")
	}
	if string(result.body) != string(testPNG("final")) {
		t.Fatalf("最终字节不符：%q", result.body)
	}
}

// 跨 host 的跳转必须被拒绝，不得对目标主机出网。
func TestFetchResourceRejectsCrossHostRedirect(t *testing.T) {
	reached := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		writeBytes(w, "image/png", testPNG("cross"))
	}))
	defer other.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/icon.png", http.StatusFound)
	}))
	defer origin.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	_, failure := fetchResource(context.Background(), client, origin.URL+"/icon.png", fetchOptions{
		timeout:      5 * time.Second,
		maxBytes:     ImageMaxBytes,
		maxRedirects: MaxRedirects,
	})
	if failure == nil {
		t.Fatal("跨 host 跳转必须失败")
	}
	if failure.kind != failureRedirect {
		t.Fatalf("失败分类 = %q，期望 %q", failure.kind, failureRedirect)
	}
	if reached {
		t.Fatal("被拒绝的跳转不得对目标主机发起请求")
	}
}

// 跳转次数用尽后按跳转失败返回。
func TestFetchResourceTooManyRedirects(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, server.URL+"/loop", http.StatusFound)
	}))
	defer server.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	_, failure := fetchResource(context.Background(), client, server.URL+"/loop", fetchOptions{
		timeout:      5 * time.Second,
		maxBytes:     ImageMaxBytes,
		maxRedirects: 2,
	})
	if failure == nil || failure.kind != failureRedirect {
		t.Fatalf("应因跳转次数过多失败，实得 %+v", failure)
	}
}

// 响应体超过上限即失败，不能把整段内容读进内存后再判。
func TestFetchResourceRejectsOversizedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeBytes(w, "image/png", testPNG(strings.Repeat("a", 4096)))
	}))
	defer server.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	_, failure := fetchResource(context.Background(), client, server.URL, fetchOptions{
		timeout:      5 * time.Second,
		maxBytes:     1024,
		maxRedirects: MaxRedirects,
	})
	if failure == nil || failure.kind != failureTooLarge {
		t.Fatalf("超限响应应按体积失败，实得 %+v", failure)
	}
}

// 超时按 timeout 分类返回，不泄漏底层错误。
func TestFetchResourceTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		writeBytes(w, "image/png", testPNG("late"))
	}))
	defer server.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	_, failure := fetchResource(context.Background(), client, server.URL, fetchOptions{
		timeout:      30 * time.Millisecond,
		maxBytes:     ImageMaxBytes,
		maxRedirects: MaxRedirects,
	})
	if failure == nil || failure.kind != failureTimeout {
		t.Fatalf("应因超时失败，实得 %+v", failure)
	}
}

// 取图请求必须匿名：即使调用方持有其它站点的 Cookie，也不随取图请求发出。
func TestFetchResourceSendsNoCookies(t *testing.T) {
	var cookie string
	var agent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie = r.Header.Get("Cookie")
		agent = r.Header.Get("User-Agent")
		writeBytes(w, "image/png", testPNG("ok"))
	}))
	defer server.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	if _, failure := fetchResource(context.Background(), client, server.URL, fetchOptions{
		timeout:      5 * time.Second,
		maxBytes:     ImageMaxBytes,
		maxRedirects: MaxRedirects,
	}); failure != nil {
		t.Fatalf("请求应成功，实得 %+v", failure)
	}
	if cookie != "" {
		t.Fatalf("取图请求不得携带 Cookie，实得 %q", cookie)
	}
	if agent != fetchAgent {
		t.Fatalf("User-Agent = %q，期望 %q", agent, fetchAgent)
	}
}

// 非 2xx 状态按 HTTP 失败返回并带上状态码。
func TestFetchResourceNon2xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeStatus(w, http.StatusNotFound)
	}))
	defer server.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	_, failure := fetchResource(context.Background(), client, server.URL, fetchOptions{
		timeout:      5 * time.Second,
		maxBytes:     ImageMaxBytes,
		maxRedirects: MaxRedirects,
	})
	if failure == nil || failure.kind != failureHTTP || failure.statusCode != http.StatusNotFound {
		t.Fatalf("应按 HTTP 失败返回 404，实得 %+v", failure)
	}
}

// 下载候选时跳过失败项与跨主机引用，只保留成功字节。
func TestDownloadCandidatesSkipsFailuresAndForeignHosts(t *testing.T) {
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeBytes(w, "image/png", testPNG("foreign"))
	}))
	defer foreign.Close()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok.png":
			writeBytes(w, "image/png", testPNG("ok"))
		default:
			writeStatus(w, http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := newFetchClient()
	defer client.CloseIdleConnections()

	refs := []iconRef{
		{href: foreign.URL + "/foreign.png", tier: TierRelIcon},
		{href: server.URL + "/missing.png", tier: TierRelIcon},
		{href: server.URL + "/ok.png", tier: TierStaticFavicon},
	}
	downloaded := downloadCandidates(context.Background(), client, refs, fetchOptions{
		timeout:      5 * time.Second,
		maxBytes:     ImageMaxBytes,
		maxRedirects: MaxRedirects,
	}, server.URL, MaxCandidates)

	if len(downloaded) != 1 {
		t.Fatalf("应只保留 1 份字节，实得 %d", len(downloaded))
	}
	if downloaded[0].ref.href != server.URL+"/ok.png" || string(downloaded[0].body) != string(testPNG("ok")) {
		t.Fatalf("保留的候选不符：%+v", downloaded[0].ref)
	}
}

// 清理名称只留安全字符，并压掉连续分隔符与首尾分隔符。
func TestSanitizeBase(t *testing.T) {
	cases := map[string]string{
		"Example.COM":           "example.com",
		"192.168.1.10":          "192.168.1.10",
		"a b/c":                 "a-b-c",
		"___":                   "___",
		"--Edge--":              "edge",
		strings.Repeat("a", 60): strings.Repeat("a", filenameMaxBase),
	}
	for input, want := range cases {
		if got := sanitizeBase(input); got != want {
			t.Fatalf("%q 清洗结果 = %q，期望 %q", input, got, want)
		}
	}
	if got := sanitizeBase("///"); got != filenameFallbackBase {
		t.Fatalf("全分隔符应回落默认前缀，实得 %q", got)
	}
}
