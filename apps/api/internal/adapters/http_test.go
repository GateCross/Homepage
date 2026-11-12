package adapters

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 构造一个回固定正文的本地服务，并记录收到的请求头。
func newTestServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

// 取测试服务的端口，供跨源跳转用例改写主机名时复用。
func portOf(t *testing.T, rawURL string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("测试地址无法解析：%v", err)
	}
	return parsed.Port()
}

func TestDoReturnsBodyAndStatus(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v2/transfer/info" {
			t.Errorf("请求路径应为 /api/v2/transfer/info，实得 %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"dl_info_speed":1024}`))
	})

	response, err := Do(context.Background(), server.URL+"/api/v2/transfer/info", RequestOptions{})
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if response.Status != http.StatusOK {
		t.Fatalf("状态码应为 200，实得 %d", response.Status)
	}
	if !response.OK() {
		t.Fatal("2xx 应判定为成功")
	}
	if got := response.Text(); got != `{"dl_info_speed":1024}` {
		t.Fatalf("正文不符：%q", got)
	}
}

func TestDoMapsTimeoutToChineseMessage(t *testing.T) {
	// 服务端睡过超时窗口，客户端必须按超时映射而不是原样抛底层错误
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte("{}"))
	})

	_, err := Do(context.Background(), server.URL, RequestOptions{Timeout: 30 * time.Millisecond})
	if err == nil {
		t.Fatal("超时必须返回错误")
	}
	if got := err.Error(); got != "请求外部服务超时" {
		t.Fatalf("超时文案应为默认中文提示，实得 %q", got)
	}
}

func TestDoUsesCustomTimeoutMessage(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte("{}"))
	})

	_, err := Do(context.Background(), server.URL, RequestOptions{
		Timeout:        30 * time.Millisecond,
		TimeoutMessage: "获取 qBittorrent 传输信息超时",
	})
	if err == nil {
		t.Fatal("超时必须返回错误")
	}
	if got := err.Error(); got != "获取 qBittorrent 传输信息超时" {
		t.Fatalf("应回显调用方给定的超时文案，实得 %q", got)
	}
}

func TestDoMapsNetworkFailureToChineseMessage(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {})
	endpoint := server.URL
	server.Close()

	_, err := Do(context.Background(), endpoint, RequestOptions{NetworkMessage: "无法连接 qBittorrent 登录接口"})
	if err == nil {
		t.Fatal("连接失败必须返回错误")
	}
	if got := err.Error(); got != "无法连接 qBittorrent 登录接口" {
		t.Fatalf("应回显调用方给定的网络失败文案，实得 %q", got)
	}
}

func TestDoKeepsCallerCancellation(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := Do(ctx, server.URL, RequestOptions{})
	if err == nil {
		t.Fatal("调用方取消必须返回错误")
	}
	if !errors.Is(err, ErrCancelled) {
		t.Fatalf("调用方取消应返回可判定的取消原因，实得 %v", err)
	}
	if got := err.Error(); got == "请求外部服务超时" {
		t.Fatal("调用方取消不应被映射成超时文案")
	}
	if strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("错误消息应为中文：%q", err.Error())
	}
}

func TestDoMapsDeadlineToTimeoutMessage(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	})

	// 调用方自带的截止时间同样按超时文案输出，而不是透传底层错误
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	_, err := Do(ctx, server.URL, RequestOptions{})
	if err == nil {
		t.Fatal("截止时间到期必须返回错误")
	}
	if got := err.Error(); got != "请求外部服务超时" {
		t.Fatalf("截止时间应映射为超时文案，实得 %q", got)
	}
}

func TestDoRejectsOversizedBody(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("a", 4096)))
	})

	_, err := Do(context.Background(), server.URL, RequestOptions{MaxBytes: 1024})
	if err == nil {
		t.Fatal("超出上限必须返回错误")
	}
	if got := err.Error(); got != "外部服务响应体积超过限制" {
		t.Fatalf("超限文案不符：%q", got)
	}
}

func TestDoAcceptsBodyExactlyAtLimit(t *testing.T) {
	payload := strings.Repeat("a", 1024)
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(payload))
	})

	response, err := Do(context.Background(), server.URL, RequestOptions{MaxBytes: 1024})
	if err != nil {
		t.Fatalf("恰好等于上限不应判超限：%v", err)
	}
	if len(response.Body) != 1024 {
		t.Fatalf("正文长度应为 1024，实得 %d", len(response.Body))
	}
}

func TestDoUsesLargeLimitForDownloadClients(t *testing.T) {
	if LargeMaxResponseBytes != 32<<20 {
		t.Fatalf("下载客户端上限应为 32MB，实得 %d", LargeMaxResponseBytes)
	}
	if LargeMaxResponseBytes <= DefaultMaxResponseBytes {
		t.Fatal("下载客户端上限必须大于默认上限")
	}
}

func TestDoErrorExcludesURLAndHeaders(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {})
	endpoint := server.URL + "/api/v2/auth/login?secret=TOP-SECRET-VALUE"
	server.Close()

	_, err := Do(context.Background(), endpoint, RequestOptions{
		Method:  http.MethodPost,
		Headers: map[string]string{"Authorization": "Bearer TOP-SECRET-VALUE"},
		Body:    []byte("password=TOP-SECRET-VALUE"),
	})
	if err == nil {
		t.Fatal("连接失败必须返回错误")
	}
	message := err.Error()
	if strings.Contains(message, "TOP-SECRET-VALUE") {
		t.Fatalf("错误消息不得含密钥：%q", message)
	}
	if strings.Contains(message, server.URL) || strings.Contains(message, "127.0.0.1") {
		t.Fatalf("错误消息不得含目标地址：%q", message)
	}
}

func TestDoSanitizesInvalidURL(t *testing.T) {
	for _, target := range []string{
		"ftp://example.com/api",
		"not-a-url",
		"://missing-scheme",
		"/relative/only",
	} {
		_, err := Do(context.Background(), target, RequestOptions{})
		if err == nil {
			t.Fatalf("%q 应被判为无效目标", target)
		}
		if strings.Contains(err.Error(), target) {
			t.Fatalf("错误消息不得回显目标地址：%q", err.Error())
		}
	}
}

func TestDoSendsCustomHeaders(t *testing.T) {
	var token string
	var contentType string
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		token = r.Header.Get("X-Emby-Token")
		contentType = r.Header.Get("Content-Type")
	})

	_, err := Do(context.Background(), server.URL, RequestOptions{
		Method: http.MethodPost,
		Headers: map[string]string{
			"X-Emby-Token": "abc123",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		Body: []byte("username=admin&password=pw"),
	})
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	if token != "abc123" {
		t.Fatalf("请求头未送达，实得 %q", token)
	}
	if contentType != "application/x-www-form-urlencoded" {
		t.Fatalf("内容类型不符：%q", contentType)
	}
}

func TestDoReadsMultipleSetCookieLines(t *testing.T) {
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		// qBittorrent 登录会同时下多个 cookie，SID 只在一行里
		w.Header().Add("Set-Cookie", "QBT_SID_8080=value-a; Path=/; HttpOnly")
		w.Header().Add("Set-Cookie", "SID=sid-value-123; Path=/; HttpOnly")
		_, _ = w.Write([]byte("Ok."))
	})

	response, err := Do(context.Background(), server.URL, RequestOptions{})
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	lines := response.SetCookieLines()
	if len(lines) != 2 {
		t.Fatalf("应读到两行 Set-Cookie，实得 %d：%v", len(lines), lines)
	}
	sid, ok := response.CookieValue("SID")
	if !ok || sid != "sid-value-123" {
		t.Fatalf("应取到 SID，实得 %q（ok=%v）", sid, ok)
	}
	if _, ok := response.CookieValue("UNKNOWN"); ok {
		t.Fatal("不存在的 Cookie 不应返回值")
	}
}

func TestDoSkipsTLSVerificationByDefault(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	// 自签证书默认放行，与内网部署保持一致
	if _, err := Do(context.Background(), server.URL, RequestOptions{}); err != nil {
		t.Fatalf("默认应跳过证书校验：%v", err)
	}
}

func TestDoVerifiesTLSWhenAsked(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(server.Close)

	// 显式要求校验时自签证书必须失败，且只回显中文网络文案
	_, err := Do(context.Background(), server.URL, RequestOptions{VerifyTLS: true})
	if err == nil {
		t.Fatal("开启校验后自签证书应握手失败")
	}
	if got := err.Error(); got != "无法连接外部服务" {
		t.Fatalf("证书失败应映射为中文网络文案，实得 %q", got)
	}
}

func TestAdapterTransportTLSConfig(t *testing.T) {
	skip := newAdapterTransport(false)
	if skip.TLSClientConfig == nil || !skip.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("默认传输层应跳过证书校验")
	}

	verify := newAdapterTransport(true)
	if verify.TLSClientConfig != nil && verify.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("显式校验时不得跳过证书校验")
	}
}

func TestDoFollowsRedirectAndDropsCredentials(t *testing.T) {
	var crossOriginCookie string
	target := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		crossOriginCookie = r.Header.Get("Cookie")
		_, _ = w.Write([]byte(`{"moved":true}`))
	})
	// 用不同主机名制造跨源跳转
	redirector := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://localhost:"+portOf(t, target.URL)+"/final")
		w.WriteHeader(http.StatusFound)
	})

	response, err := Do(context.Background(), redirector.URL, RequestOptions{
		Headers: map[string]string{"Cookie": "SID=must-not-leak"},
	})
	if err != nil {
		t.Fatalf("应跟随跳转：%v", err)
	}
	if got := response.Text(); got != `{"moved":true}` {
		t.Fatalf("跳转后正文不符：%q", got)
	}
	if crossOriginCookie != "" {
		t.Fatalf("跨源跳转必须剥掉 Cookie，实得 %q", crossOriginCookie)
	}
}

func TestDoStopsAfterTooManyRedirects(t *testing.T) {
	var server *httptest.Server
	server = newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, server.URL, http.StatusFound)
	})

	_, err := Do(context.Background(), server.URL, RequestOptions{Timeout: 5 * time.Second})
	if err == nil {
		t.Fatal("无限跳转必须失败")
	}
	if got := err.Error(); got != "外部服务重定向次数过多" {
		t.Fatalf("跳转超限文案不符：%q", got)
	}
}

func TestReadJSONBodyRejectsInvalidJSON(t *testing.T) {
	response := &Response{Status: 200, Body: []byte("<html>not json</html>")}

	_, err := ReadJSONBody(response, "qBittorrent 传输信息不是有效 JSON")
	if err == nil {
		t.Fatal("非法 JSON 必须返回错误")
	}
	if got := err.Error(); got != "qBittorrent 传输信息不是有效 JSON" {
		t.Fatalf("应回显调用方给定的文案，实得 %q", got)
	}
	if strings.Contains(err.Error(), "html") {
		t.Fatal("错误消息不得包含响应正文")
	}
}

func TestReadJSONBodyParsesObject(t *testing.T) {
	response := &Response{Status: 200, Body: []byte(`{"dl_info_speed":"2048"}`)}

	value, err := ReadJSONBody(response, "")
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("应解析成对象，实得 %T", value)
	}
	if object["dl_info_speed"] != "2048" {
		t.Fatalf("字段值不符：%v", object["dl_info_speed"])
	}
}

func TestReadJSONBodyRejectsNilResponse(t *testing.T) {
	if _, err := ReadJSONBody(nil, ""); err == nil {
		t.Fatal("空响应必须返回错误")
	}
}

func TestLocalErrorMessageFallsBack(t *testing.T) {
	if got := LocalErrorMessage(NewError("读取外部服务响应失败"), "兜底"); got != "读取外部服务响应失败" {
		t.Fatalf("应取本地原因，实得 %q", got)
	}
	if got := LocalErrorMessage(context.Canceled, "兜底"); got != "兜底" {
		t.Fatalf("非本地错误应回退，实得 %q", got)
	}
	if got := LocalErrorMessage(nil, "兜底"); got != "兜底" {
		t.Fatalf("空错误应回退，实得 %q", got)
	}
}

func TestJoinBaseURLKeepsPathPrefix(t *testing.T) {
	cases := []struct {
		base string
		path string
		want string
	}{
		{"http://192.168.1.10:8096", "/Sessions", "http://192.168.1.10:8096/Sessions"},
		{"http://192.168.1.10:8096/", "/Sessions", "http://192.168.1.10:8096/Sessions"},
		{"http://192.168.1.10:8096/emby", "/Sessions", "http://192.168.1.10:8096/emby/Sessions"},
		{"http://192.168.1.10:8096/emby/", "Sessions", "http://192.168.1.10:8096/emby/Sessions"},
		{"https://media.example.com", "api/v2/torrents/info", "https://media.example.com/api/v2/torrents/info"},
		{"https://media.example.com/caddy//", "/metrics", "https://media.example.com/caddy/metrics"},
	}

	for _, testCase := range cases {
		got, err := JoinBaseURL(testCase.base, testCase.path)
		if err != nil {
			t.Fatalf("拼接 %q + %q 失败：%v", testCase.base, testCase.path, err)
		}
		if got != testCase.want {
			t.Fatalf("拼接 %q + %q 应为 %q，实得 %q", testCase.base, testCase.path, testCase.want, got)
		}
	}
}

func TestJoinBaseURLDropsQueryAndFragment(t *testing.T) {
	got, err := JoinBaseURL("http://host:8096/emby?a=1#frag", "/Sessions")
	if err != nil {
		t.Fatalf("拼接失败：%v", err)
	}
	if got != "http://host:8096/emby/Sessions" {
		t.Fatalf("应丢弃查询与锚点，实得 %q", got)
	}
}

func TestJoinBaseURLRejectsInvalidTarget(t *testing.T) {
	for _, base := range []string{"", "ftp://host/emby", "not-a-url", "://bad"} {
		if _, err := JoinBaseURL(base, "/Sessions"); err == nil {
			t.Fatalf("%q 应被判为无效目标", base)
		}
	}
}
