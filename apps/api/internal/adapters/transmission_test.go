package adapters

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 供测试使用的凭据与会话头，登录响应会回显这些值以确认不外泄。
const (
	transmissionTestUser      = "homepage-user"
	transmissionTestPassword  = "S3cret-Passw0rd"
	transmissionTestSessionID = "session-id-value"
)

// 收到的一次 RPC 请求，供断言方法与请求头。
type transmissionCall struct {
	method    string
	sessionID string
	auth      string
	body      map[string]any
}

// 按顺序记录每次 RPC 调用，响应由 handler 决定。
type fakeTransmission struct {
	handler http.HandlerFunc
	calls   []transmissionCall
}

// 起一个假 Transmission 服务并返回其地址。
func startTransmission(t *testing.T, fake *fakeTransmission) string {
	t.Helper()
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transmission/rpc" {
			t.Errorf("RPC 路径应为 /transmission/rpc，实得 %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}

		call := transmissionCall{
			method:    r.Method,
			sessionID: r.Header.Get("X-Transmission-Session-Id"),
			auth:      r.Header.Get("Authorization"),
		}
		if err := json.NewDecoder(r.Body).Decode(&call.body); err != nil {
			t.Errorf("RPC 请求体不是有效 JSON：%v", err)
		}
		fake.calls = append(fake.calls, call)

		if fake.handler != nil {
			fake.handler(w, r)
			return
		}
		writeTransmissionDefault(t, w, call.body)
	})
	return server.URL
}

// 未覆写时的默认响应：会话统计与种子列表。
func writeTransmissionDefault(t *testing.T, w http.ResponseWriter, body map[string]any) {
	t.Helper()
	switch body["method"] {
	case "session-stats":
		_, _ = w.Write([]byte(`{"arguments":{"downloadSpeed":1500000,"uploadSpeed":500},"result":"success"}`))
	case "torrent-get":
		_, _ = w.Write([]byte(`{"arguments":{"torrents":[{"status":4},{"status":6}]},"result":"success"}`))
	default:
		t.Errorf("未知的 RPC 方法：%v", body["method"])
		_, _ = w.Write([]byte(`{"result":"success"}`))
	}
}

// 构造一次带凭据的调用输入。
func transmissionInput(url string) RunInput {
	return RunInput{
		URL:     url,
		Secrets: map[string]string{"username": transmissionTestUser, "password": transmissionTestPassword},
	}
}

// 执行一次适配器调用并规范结果；适配器层不应向外抛错。
func runTransmission(t *testing.T, input RunInput) ServiceWidgetResult {
	t.Helper()
	raw, err := transmissionAdapter{}.Run(context.Background(), input)
	if err != nil {
		t.Fatalf("适配器不应返回底层错误：%v", err)
	}
	return Validate(raw)
}

func TestTransmissionHandshakeOn409(t *testing.T) {
	// 未带会话头的首次请求回 409 并下发会话头，带该头重试才能成功
	fake := &fakeTransmission{}
	fake.handler = func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Transmission-Session-Id") != transmissionTestSessionID {
			w.Header().Set("X-Transmission-Session-Id", transmissionTestSessionID)
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte("<h1>409: Conflict</h1>"))
			return
		}
		// 请求体已由分发层读过，这里直接按记录下来的方法分派
		writeTransmissionDefault(t, w, fake.calls[len(fake.calls)-1].body)
	}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if !out.Ok {
		t.Fatalf("409 握手后应成功，实得失败：%q", out.Error)
	}

	// 首次请求无会话头，重试请求带新会话头
	if fake.calls[0].sessionID != "" {
		t.Fatalf("首次请求不应带会话头，实得 %q", fake.calls[0].sessionID)
	}
	// 会话头在后续调用中复用，无需再次 409
	for _, call := range fake.calls[1:] {
		if call.sessionID != transmissionTestSessionID {
			t.Fatalf("重试应带上新会话头，实得 %q", call.sessionID)
		}
	}
	if len(fake.calls) < 3 {
		t.Fatalf("两次 RPC 各握手一次应至少四条请求，实得 %d", len(fake.calls))
	}
}

func TestTransmissionSendsBasicAuth(t *testing.T) {
	fake := &fakeTransmission{}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(fake.calls) == 0 {
		t.Fatal("必须至少发出一次 RPC")
	}
	// Basic 头的载荷是 username:password 的 base64
	want := "Basic aG9tZXBhZ2UtdXNlcjpTM2NyZXQtUGFzc3cwcmQ="
	for _, call := range fake.calls {
		if call.auth != want {
			t.Fatalf("鉴权头不符：%q", call.auth)
		}
		if call.method != http.MethodPost {
			t.Fatalf("RPC 必须用 POST，实得 %q", call.method)
		}
	}
}

func TestTransmissionBuildsFourMetrics(t *testing.T) {
	fake := &fakeTransmission{}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
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
	if got := metricByID(t, out.Metrics, "downloading"); got.Value != 1 {
		t.Fatalf("下载中数量应为 1，实得 %v", got.Value)
	}
	if got := metricByID(t, out.Metrics, "seeding"); got.Value != 1 {
		t.Fatalf("做种数量应为 1，实得 %v", got.Value)
	}
}

func TestTransmissionCountsWaitingStatuses(t *testing.T) {
	// 3 与 5 是排队中的下载与做种，必须计入各自数量
	fake := &fakeTransmission{}
	fake.handler = func(w http.ResponseWriter, r *http.Request) {
		// 请求体已由分发层读过，这里直接取记录下来的方法
		body := fake.calls[len(fake.calls)-1].body
		if body["method"] == "torrent-get" {
			_, _ = w.Write([]byte(`{"arguments":{"torrents":[
				{"status":3},{"status":4},{"status":4},
				{"status":5},{"status":6},
				{"status":0},{"status":"paused"}
			]}}`))
			return
		}
		writeTransmissionDefault(t, w, body)
	}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if got := metricByID(t, out.Metrics, "downloading"); got.Value != 3 {
		t.Fatalf("下载中数量应为 3，实得 %v", got.Value)
	}
	if got := metricByID(t, out.Metrics, "seeding"); got.Value != 2 {
		t.Fatalf("做种数量应为 2，实得 %v", got.Value)
	}
}

func TestTransmissionDowngradesCountsWhenTorrentsFail(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"非 JSON", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<html>not json</html>"))
		}},
		{"缺 torrents", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"arguments":{"result":"success"}}`))
		}},
		{"服务端错误", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := testCase.handler
			fake := &fakeTransmission{}
			fake.handler = func(w http.ResponseWriter, r *http.Request) {
				// 请求体已由分发层读过，这里直接取记录下来的方法
				body := fake.calls[len(fake.calls)-1].body
				if body["method"] == "torrent-get" {
					handler(w, r)
					return
				}
				writeTransmissionDefault(t, w, body)
			}
			url := startTransmission(t, fake)

			out := runTransmission(t, transmissionInput(url))
			if !out.Ok {
				t.Fatalf("数量失败不应拖垮整卡，实得失败：%q", out.Error)
			}
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

func TestTransmissionFailsWhenNoSessionHeaderOn409(t *testing.T) {
	// 409 没有下发会话头时无法重试，必须失败而不是死循环
	fake := &fakeTransmission{
		handler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte("<h1>409: Conflict</h1>"))
		},
	}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if out.Ok {
		t.Fatal("缺少会话头必须失败")
	}
	if out.Error != transmissionSessionIDFail {
		t.Fatalf("失败文案应为 %q，实得 %q", transmissionSessionIDFail, out.Error)
	}
	if len(fake.calls) != 1 {
		t.Fatalf("缺少会话头时不应重试，实际请求 %d 次", len(fake.calls))
	}
}

func TestTransmissionStopsAfterSecond409(t *testing.T) {
	// 会话头换了仍然 409，只允许重试一次
	fake := &fakeTransmission{}
	fake.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Transmission-Session-Id", "session-"+strings.Repeat("y", len(fake.calls)))
		w.WriteHeader(http.StatusConflict)
	}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if out.Ok {
		t.Fatal("连续 409 必须失败")
	}
	if out.Error != transmissionSessionIDFail {
		t.Fatalf("失败文案应为 %q，实得 %q", transmissionSessionIDFail, out.Error)
	}
	if len(fake.calls) != transmissionRPCMaxAttempts {
		t.Fatalf("最多重试一次，实际请求 %d 次", len(fake.calls))
	}
}

func TestTransmissionRejectsInvalidJSON(t *testing.T) {
	fake := &fakeTransmission{
		handler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<html>oops</html>"))
		},
	}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if out.Ok {
		t.Fatal("非 JSON 响应必须失败")
	}
	if out.Error != transmissionRPCBadJSON {
		t.Fatalf("失败文案应为 %q，实得 %q", transmissionRPCBadJSON, out.Error)
	}
	if strings.Contains(out.Error, "html") {
		t.Fatal("失败文案不得包含响应正文")
	}
}

func TestTransmissionRejectsMissingRateFields(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"缺 uploadSpeed", `{"arguments":{"downloadSpeed":1024}}`},
		{"缺 downloadSpeed", `{"arguments":{"uploadSpeed":1024}}`},
		{"速率非数字", `{"arguments":{"downloadSpeed":"fast","uploadSpeed":1024}}`},
		{"arguments 是数组", `{"arguments":[1,2]}`},
		{"顶层是数组", `[1,2,3]`},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := testCase.body
			fake := &fakeTransmission{
				handler: func(w http.ResponseWriter, r *http.Request) {
					_, _ = w.Write([]byte(body))
				},
			}
			url := startTransmission(t, fake)

			out := runTransmission(t, transmissionInput(url))
			if out.Ok {
				t.Fatal("缺少速率字段必须失败")
			}
			if out.Error != transmissionRPCBadFields {
				t.Fatalf("失败文案应为 %q，实得 %q", transmissionRPCBadFields, out.Error)
			}
		})
	}
}

func TestTransmissionWithoutCredentialsSkipsAuthHeader(t *testing.T) {
	fake := &fakeTransmission{}
	url := startTransmission(t, fake)

	out := runTransmission(t, RunInput{URL: url})
	if !out.Ok {
		t.Fatalf("无凭据时仍应可匿名访问，实得失败：%q", out.Error)
	}
	for _, call := range fake.calls {
		if call.auth != "" {
			t.Fatalf("无用户名时不得发送鉴权头，实得 %q", call.auth)
		}
	}
}

func TestTransmissionNeverLeaksSessionIDOrCredentials(t *testing.T) {
	// 响应里回显凭据与会话头，仍然不得进入失败文案
	fake := &fakeTransmission{
		handler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(transmissionTestSessionID + " " + transmissionTestPassword))
		},
	}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if out.Ok {
		t.Fatal("非 2xx 必须失败")
	}
	secrets := map[string]string{
		"username":  transmissionTestUser,
		"password":  transmissionTestPassword,
		"sessionId": transmissionTestSessionID,
	}
	if ContainsAnySecret(out.Error, secrets) {
		t.Fatalf("失败文案不得含会话头或凭据：%q", out.Error)
	}
	if out.Error != transmissionRPCFail {
		t.Fatalf("失败文案应为 %q，实得 %q", transmissionRPCFail, out.Error)
	}
}

func TestTransmissionAdapterIsRegistered(t *testing.T) {
	adapter, ok := Get("transmission")
	if !ok {
		t.Fatal("transmission 必须在初始化时登记到默认注册表")
	}
	if adapter.Type() != "transmission" {
		t.Fatalf("类型名应为 transmission，实得 %q", adapter.Type())
	}
}

func TestTransmissionReadsRatesFromRootWhenArgumentsMissing(t *testing.T) {
	// arguments 缺失时退回根对象读字段
	fake := &fakeTransmission{
		handler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"downloadSpeed":"1500000","uploadSpeed":500}`))
		},
	}
	url := startTransmission(t, fake)

	out := runTransmission(t, transmissionInput(url))
	if !out.Ok {
		t.Fatalf("应接受根级字段，实得失败：%q", out.Error)
	}
	if got := metricByID(t, out.Metrics, "download"); metricNumber(t, got) != 1.5 || got.Unit != "MB/s" {
		t.Fatalf("根级下载速率应被读到：%+v", got)
	}
}
