package adapters

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// 供测试使用的凭据，登录接口会在正文与 Cookie 里回显这些值以确认不外泄。
const (
	qbittorrentTestUser     = "homepage-user"
	qbittorrentTestPassword = "S3cret-Passw0rd"
	qbittorrentTestSID      = "sid-session-value"
)

// 按路径分发的假 qBittorrent：登录、传输信息与种子列表各自可覆写。
type fakeQbittorrent struct {
	loginHandler    http.HandlerFunc
	transferHandler http.HandlerFunc
	torrentHandler  http.HandlerFunc
	requests        int
}

// 起一个假服务并返回其地址；未覆写的路径返回最小可用响应。
func startQbittorrent(t *testing.T, fake *fakeQbittorrent) string {
	t.Helper()
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		fake.requests++
		switch r.URL.Path {
		case "/api/v2/auth/login":
			if fake.loginHandler != nil {
				fake.loginHandler(w, r)
				return
			}
			w.Header().Add("Set-Cookie", "SID="+qbittorrentTestSID+"; Path=/; HttpOnly")
			_, _ = w.Write([]byte("Ok."))
		case "/api/v2/transfer/info":
			if fake.transferHandler != nil {
				fake.transferHandler(w, r)
				return
			}
			_, _ = w.Write([]byte(`{"dl_info_speed":1500000,"up_info_speed":500}`))
		case "/api/v2/torrents/info":
			if fake.torrentHandler != nil {
				fake.torrentHandler(w, r)
				return
			}
			_, _ = w.Write([]byte(`[{},{"status":"stalledUP"}]`))
		default:
			http.NotFound(w, r)
		}
	})
	return server.URL
}

// 构造一次带凭据的调用输入。
func qbittorrentInput(url string) RunInput {
	return RunInput{
		URL:     url,
		Secrets: map[string]string{"username": qbittorrentTestUser, "password": qbittorrentTestPassword},
	}
}

// 从结果里取指定标识的指标。
func metricByID(t *testing.T, metrics []Metric, id string) Metric {
	t.Helper()
	for _, metric := range metrics {
		if metric.ID == id {
			return metric
		}
	}
	t.Fatalf("缺少标识为 %q 的指标：%+v", id, metrics)
	return Metric{}
}

// 执行一次适配器调用并规范结果；适配器层不应向外抛错。
func runQbittorrent(t *testing.T, input RunInput) ServiceWidgetResult {
	t.Helper()
	raw, err := qbittorrentAdapter{}.Run(context.Background(), input)
	if err != nil {
		t.Fatalf("适配器不应返回底层错误：%v", err)
	}
	return Validate(raw)
}

// 把指标值读成数值，供浮点比较；非数值即判失败。
func metricNumber(t *testing.T, metric Metric) float64 {
	t.Helper()
	number, ok := CoerceFiniteNumber(metric.Value)
	if !ok {
		t.Fatalf("指标 %q 的值不是数值：%v", metric.ID, metric.Value)
	}
	return number
}

func TestQbittorrentLoginSendsFormAndReadsSID(t *testing.T) {
	var method string
	var contentType string
	var formUser string
	var formPassword string
	fake := &fakeQbittorrent{
		loginHandler: func(w http.ResponseWriter, r *http.Request) {
			method = r.Method
			contentType = r.Header.Get("Content-Type")
			if err := r.ParseForm(); err != nil {
				t.Errorf("表单解析失败：%v", err)
			}
			formUser = r.PostForm.Get("username")
			formPassword = r.PostForm.Get("password")
			// 多行 Set-Cookie 时 SID 只在一行里
			w.Header().Add("Set-Cookie", "QBT_SID_8080=other; Path=/; HttpOnly")
			w.Header().Add("Set-Cookie", "SID="+qbittorrentTestSID+"; Path=/; HttpOnly")
			_, _ = w.Write([]byte("Ok."))
		},
	}
	url := startQbittorrent(t, fake)

	result, err := qbittorrentAdapter{}.Run(context.Background(), qbittorrentInput(url))
	if err != nil {
		t.Fatalf("适配器不应返回底层错误：%v", err)
	}
	out := Validate(result)
	if !out.Ok {
		t.Fatalf("登录成功应返回成功结果，实得失败：%q", out.Error)
	}
	if method != http.MethodPost {
		t.Fatalf("登录必须用 POST，实得 %q", method)
	}
	if contentType != "application/x-www-form-urlencoded" {
		t.Fatalf("登录表单类型不符：%q", contentType)
	}
	if formUser != qbittorrentTestUser || formPassword != qbittorrentTestPassword {
		t.Fatalf("登录表单字段不符：username=%q password=%q", formUser, formPassword)
	}
}

func TestQbittorrentSendsSIDAsCookie(t *testing.T) {
	var cookies []string
	fake := &fakeQbittorrent{
		transferHandler: func(w http.ResponseWriter, r *http.Request) {
			cookies = append(cookies, r.Header.Get("Cookie"))
			_, _ = w.Write([]byte(`{"dl_info_speed":0,"up_info_speed":0}`))
		},
		torrentHandler: func(w http.ResponseWriter, r *http.Request) {
			cookies = append(cookies, r.Header.Get("Cookie"))
			_, _ = w.Write([]byte(`[]`))
		},
	}
	url := startQbittorrent(t, fake)

	out := runQbittorrent(t, qbittorrentInput(url))
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(cookies) == 0 {
		t.Fatal("传输信息与种子列表都必须携带会话 Cookie")
	}
	for _, cookie := range cookies {
		if cookie != "SID="+qbittorrentTestSID {
			t.Fatalf("会话 Cookie 不符：%q", cookie)
		}
	}
}

func TestQbittorrentBuildsFourMetrics(t *testing.T) {
	fake := &fakeQbittorrent{
		transferHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"dl_info_speed":1500000,"up_info_speed":500}`))
		},
		torrentHandler: func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Query().Get("filter") {
			case "downloading":
				_, _ = w.Write([]byte(`[{},{},{}]`))
			case "seeding":
				_, _ = w.Write([]byte(`[{},{"status":"stalledUP"}]`))
			default:
				t.Errorf("种子列表必须带 filter，实得 %q", r.URL.RawQuery)
				_, _ = w.Write([]byte(`[]`))
			}
		},
	}
	url := startQbittorrent(t, fake)

	out := runQbittorrent(t, qbittorrentInput(url))
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(out.Metrics) != 4 {
		t.Fatalf("应有四项指标，实得 %d：%+v", len(out.Metrics), out.Metrics)
	}

	download := metricByID(t, out.Metrics, "download")
	if download.Unit != "MB/s" || metricNumber(t, download) != 1.5 || download.Status != MetricStatusOK {
		t.Fatalf("下载指标不符：%+v", download)
	}
	upload := metricByID(t, out.Metrics, "upload")
	if upload.Unit != "B/s" || metricNumber(t, upload) != 500 || upload.Status != MetricStatusOK {
		t.Fatalf("上传指标不符：%+v", upload)
	}
	if got := metricByID(t, out.Metrics, "downloading"); got.Value != 3 {
		t.Fatalf("下载中数量应为 3，实得 %v", got.Value)
	}
	if got := metricByID(t, out.Metrics, "seeding"); got.Value != 2 {
		t.Fatalf("做种数量应为 2，实得 %v", got.Value)
	}
}

func TestQbittorrentDowngradesCountsWhenTorrentsFail(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"非 JSON", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<html>not json</html>"))
		}},
		{"非数组", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"torrents":[]}`))
		}},
		{"服务端错误", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := &fakeQbittorrent{torrentHandler: testCase.handler}
			url := startQbittorrent(t, fake)

			out := runQbittorrent(t, qbittorrentInput(url))
			if !out.Ok {
				t.Fatalf("数量失败不应拖垮整卡，实得失败：%q", out.Error)
			}
			// 速率必须仍然可用
			if got := metricByID(t, out.Metrics, "download"); got.Status != MetricStatusOK {
				t.Fatalf("速率应保持可用：%+v", got)
			}
			for _, id := range []string{"downloading", "seeding"} {
				metric := metricByID(t, out.Metrics, id)
				if metric.Status != MetricStatusUnavailable || metric.Value != "—" {
					t.Fatalf("%s 应降级为不可用，实得 %+v", id, metric)
				}
			}
		})
	}
}

func TestQbittorrentReloginsOnceWhenSessionExpired(t *testing.T) {
	logins := 0
	transferCalls := 0
	fake := &fakeQbittorrent{
		loginHandler: func(w http.ResponseWriter, r *http.Request) {
			logins++
			w.Header().Add("Set-Cookie", "SID=session-"+strings.Repeat("x", logins)+"; Path=/")
			_, _ = w.Write([]byte("Ok."))
		},
		transferHandler: func(w http.ResponseWriter, r *http.Request) {
			transferCalls++
			// 首次会话被判失效，重登后成功
			if transferCalls == 1 {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			_, _ = w.Write([]byte(`{"dl_info_speed":1024,"up_info_speed":500}`))
		},
	}
	url := startQbittorrent(t, fake)

	out := runQbittorrent(t, qbittorrentInput(url))
	if !out.Ok {
		t.Fatalf("会话失效应自动重登，实得失败：%q", out.Error)
	}
	if logins != 2 {
		t.Fatalf("应重登一次，实际登录 %d 次", logins)
	}
}

func TestQbittorrentFailsWhenSessionExpiresTwice(t *testing.T) {
	logins := 0
	fake := &fakeQbittorrent{
		loginHandler: func(w http.ResponseWriter, r *http.Request) {
			logins++
			w.Header().Add("Set-Cookie", "SID="+qbittorrentTestSID+"; Path=/")
			_, _ = w.Write([]byte("Ok."))
		},
		transferHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		},
	}
	url := startQbittorrent(t, fake)

	out := runQbittorrent(t, qbittorrentInput(url))
	if out.Ok {
		t.Fatal("连续两次会话失效必须失败")
	}
	if out.Error != qbittorrentLoginFail {
		t.Fatalf("失败文案应为 %q，实得 %q", qbittorrentLoginFail, out.Error)
	}
	if logins != 2 {
		t.Fatalf("只允许重登一次，实际登录 %d 次", logins)
	}
}

func TestQbittorrentLoginFailures(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{
			name: "非 2xx",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte("Fails."))
			},
			want: qbittorrentLoginFail,
		},
		{
			name: "200 但正文为 Fails",
			handler: func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte("Fails."))
			},
			want: qbittorrentLoginFail,
		},
		{
			name: "未下发 SID",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Add("Set-Cookie", "QBT_SID_8080=other; Path=/")
				_, _ = w.Write([]byte("Ok."))
			},
			want: qbittorrentLoginNoSession,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := &fakeQbittorrent{loginHandler: testCase.handler}
			url := startQbittorrent(t, fake)

			out := runQbittorrent(t, qbittorrentInput(url))
			if out.Ok {
				t.Fatal("登录失败必须返回失败结果")
			}
			if out.Error != testCase.want {
				t.Fatalf("失败文案应为 %q，实得 %q", testCase.want, out.Error)
			}
			// 登录失败后不得继续请求其它接口
			if fake.requests != 1 {
				t.Fatalf("登录失败后不应再发请求，实际 %d 次", fake.requests)
			}
		})
	}
}

func TestQbittorrentMissingCredentials(t *testing.T) {
	cases := []struct {
		name    string
		secrets map[string]string
	}{
		{"缺用户名", map[string]string{"password": qbittorrentTestPassword}},
		{"缺密码", map[string]string{"username": qbittorrentTestUser}},
		{"两者都缺", map[string]string{}},
		{"空串", map[string]string{"username": "", "password": ""}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := &fakeQbittorrent{}
			url := startQbittorrent(t, fake)

			out := runQbittorrent(t, RunInput{
				URL:     url,
				Secrets: testCase.secrets,
			})
			if out.Ok {
				t.Fatal("凭据缺失必须返回失败结果")
			}
			if out.Error != qbittorrentMissingCredentials {
				t.Fatalf("失败文案应为 %q，实得 %q", qbittorrentMissingCredentials, out.Error)
			}
			if fake.requests != 0 {
				t.Fatalf("凭据缺失时不得发出任何请求，实际 %d 次", fake.requests)
			}
		})
	}
}

func TestQbittorrentRejectsInvalidTransferJSON(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"非 JSON", "<html>oops</html>", qbittorrentTransferBadJSON},
		{"缺速率字段", `{"up_info_speed":1024}`, qbittorrentTransferBadFields},
		{"速率非数字", `{"dl_info_speed":"fast","up_info_speed":1024}`, qbittorrentTransferBadFields},
		{"顶层是数组", `[1,2,3]`, qbittorrentTransferBadFields},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := testCase.body
			fake := &fakeQbittorrent{
				transferHandler: func(w http.ResponseWriter, r *http.Request) {
					_, _ = w.Write([]byte(body))
				},
			}
			url := startQbittorrent(t, fake)

			out := runQbittorrent(t, qbittorrentInput(url))
			if out.Ok {
				t.Fatal("非法传输信息必须返回失败结果")
			}
			if out.Error != testCase.want {
				t.Fatalf("失败文案应为 %q，实得 %q", testCase.want, out.Error)
			}
			if ContainsAnySecret(out.Error, qbittorrentInput(url).Secrets) {
				t.Fatalf("失败文案不得含凭据：%q", out.Error)
			}
		})
	}
}

func TestQbittorrentTransferStatusFailure(t *testing.T) {
	fake := &fakeQbittorrent{
		transferHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
	}
	url := startQbittorrent(t, fake)

	out := runQbittorrent(t, qbittorrentInput(url))
	if out.Ok {
		t.Fatal("传输信息非 2xx 必须失败")
	}
	if out.Error != qbittorrentTransferFail {
		t.Fatalf("失败文案应为 %q，实得 %q", qbittorrentTransferFail, out.Error)
	}
}

func TestQbittorrentNeverLeaksCredentials(t *testing.T) {
	// 登录接口回显凭据，仍然不得出现在结果或错误文案里
	fake := &fakeQbittorrent{
		loginHandler: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Add("Set-Cookie", "SID="+qbittorrentTestPassword+"; Path=/")
			_, _ = w.Write([]byte("Fails: " + qbittorrentTestUser + "/" + qbittorrentTestPassword))
		},
		transferHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(qbittorrentTestPassword))
		},
	}
	url := startQbittorrent(t, fake)

	out := runQbittorrent(t, qbittorrentInput(url))
	if out.Ok {
		t.Fatal("该用例应失败")
	}
	secrets := map[string]string{"username": qbittorrentTestUser, "password": qbittorrentTestPassword}
	if ContainsAnySecret(out.Error, secrets) {
		t.Fatalf("失败文案不得含凭据或 SID：%q", out.Error)
	}
}

func TestQbittorrentAdapterIsRegistered(t *testing.T) {
	adapter, ok := Get("qbittorrent")
	if !ok {
		t.Fatal("qbittorrent 必须在初始化时登记到默认注册表")
	}
	if adapter.Type() != "qbittorrent" {
		t.Fatalf("类型名应为 qbittorrent，实得 %q", adapter.Type())
	}
}

func TestQbittorrentLoginFailureBodyCheck(t *testing.T) {
	cases := []struct {
		text string
		want bool
	}{
		{"Fails.", true},
		{"fails", true},
		{" FAILS. ", true},
		{"Ok.", false},
		{"", false},
		{"failure", false},
	}

	for _, testCase := range cases {
		if got := isQbittorrentLoginRejected(testCase.text); got != testCase.want {
			t.Fatalf("%q 应判定为 %v，实得 %v", testCase.text, testCase.want, got)
		}
	}
}
