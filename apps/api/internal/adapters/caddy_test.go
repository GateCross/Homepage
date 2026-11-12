package adapters

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 供测试使用的上游列表：两条对象条目与一条非对象条目。
const caddyTestUpstreams = `[
  {"address":"10.0.0.1:8080","num_requests":120,"fails":0},
  {"address":"10.0.0.2:8080","num_requests":"80","fails":"5"},
  "not-an-object"
]`

// 起一个假 Caddy 管理接口，返回指定正文与状态码。
func startCaddy(t *testing.T, status int, body string) string {
	t.Helper()
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reverse_proxy/upstreams" {
			t.Errorf("请求路径应为 /reverse_proxy/upstreams，实得 %q", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("只允许 GET，实得 %q", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	return server.URL
}

// 执行一次适配器调用并规范结果；适配器层不应向外抛错。
func runCaddy(t *testing.T, input RunInput) ServiceWidgetResult {
	t.Helper()
	raw, err := caddyAdapter{}.Run(context.Background(), input)
	if err != nil {
		t.Fatalf("适配器不应返回底层错误：%v", err)
	}
	return Validate(raw)
}

// 把指标值读成整数，供数量比较。
func caddyNumber(t *testing.T, metric Metric) int {
	t.Helper()
	number, ok := CoerceFiniteNumber(metric.Value)
	if !ok {
		t.Fatalf("指标 %q 的值不是数值：%v", metric.ID, metric.Value)
	}
	return int(number)
}

func TestCaddyAdapterIsRegistered(t *testing.T) {
	adapter, ok := Get("caddy")
	if !ok {
		t.Fatal("caddy 必须在初始化时登记到默认注册表")
	}
	if adapter.Type() != "caddy" {
		t.Fatalf("类型名应为 caddy，实得 %q", adapter.Type())
	}
}

func TestCaddyBuildsThreeMetrics(t *testing.T) {
	url := startCaddy(t, http.StatusOK, caddyTestUpstreams)

	out := runCaddy(t, RunInput{URL: url})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(out.Metrics) != 3 {
		t.Fatalf("应有三项指标，实得 %d：%+v", len(out.Metrics), out.Metrics)
	}

	// 非对象条目也计入上游总数
	upstreams := metricByID(t, out.Metrics, "upstreams")
	if got := caddyNumber(t, upstreams); got != 3 {
		t.Fatalf("上游数应为 3，实得 %d", got)
	}
	if upstreams.Label != "上游" || upstreams.Status != MetricStatusOK {
		t.Fatalf("上游指标不符：%+v", upstreams)
	}

	// 数字与数字字符串都参与求和，小数部分截断
	requests := metricByID(t, out.Metrics, "requests")
	if got := caddyNumber(t, requests); got != 200 {
		t.Fatalf("请求数应为 200，实得 %d", got)
	}
	failed := metricByID(t, out.Metrics, "requests_failed")
	if got := caddyNumber(t, failed); got != 5 {
		t.Fatalf("失败数应为 5，实得 %d", got)
	}
}

func TestCaddyFallsBackToAlternateFieldNames(t *testing.T) {
	body := `[{"numRequests":10,"num_fails":2},{"requests":"5","failures":1}]`
	url := startCaddy(t, http.StatusOK, body)

	out := runCaddy(t, RunInput{URL: url})
	if !out.Ok {
		t.Fatalf("应接受替代字段名，实得失败：%q", out.Error)
	}
	if got := caddyNumber(t, metricByID(t, out.Metrics, "requests")); got != 15 {
		t.Fatalf("请求数应为 15，实得 %d", got)
	}
	if got := caddyNumber(t, metricByID(t, out.Metrics, "requests_failed")); got != 3 {
		t.Fatalf("失败数应为 3，实得 %d", got)
	}
}

func TestCaddyFiltersFieldsByOption(t *testing.T) {
	url := startCaddy(t, http.StatusOK, caddyTestUpstreams)

	out := runCaddy(t, RunInput{
		URL:     url,
		Options: map[string]any{"fields": []any{" upstreams ", "REQUESTS"}},
	})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(out.Metrics) != 2 {
		t.Fatalf("白名单应只留两项，实得 %d：%+v", len(out.Metrics), out.Metrics)
	}
	metricByID(t, out.Metrics, "upstreams")
	metricByID(t, out.Metrics, "requests")
}

func TestCaddyRejectsEmptyFieldFilter(t *testing.T) {
	// 白名单全是不认识的字段时没有任何指标可展示，按格式无效处理
	url := startCaddy(t, http.StatusOK, caddyTestUpstreams)

	out := runCaddy(t, RunInput{URL: url, Options: map[string]any{"fields": []string{"unknown"}}})
	if out.Ok {
		t.Fatal("白名单过滤后为空必须失败")
	}
	if out.Error != caddyStatsBadFields {
		t.Fatalf("失败文案应为 %q，实得 %q", caddyStatsBadFields, out.Error)
	}
}

func TestCaddyAcceptsStringSliceOptions(t *testing.T) {
	// 配置层可能直接给 []string，与 JSON 解出的 []any 等价
	url := startCaddy(t, http.StatusOK, caddyTestUpstreams)

	out := runCaddy(t, RunInput{URL: url, Options: map[string]any{"fields": []string{"requests"}}})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(out.Metrics) != 1 || out.Metrics[0].ID != "requests" {
		t.Fatalf("应只留请求指标：%+v", out.Metrics)
	}
}

func TestCaddyAcceptsNonObjectOptions(t *testing.T) {
	// 选项形态不符时按全选处理，不拖垮整卡
	url := startCaddy(t, http.StatusOK, caddyTestUpstreams)

	for name, options := range map[string]any{
		"缺省":         nil,
		"字符串":        "fields=upstreams",
		"数组":         []any{"upstreams"},
		"fields 非列表": map[string]any{"fields": "upstreams"},
	} {
		t.Run(name, func(t *testing.T) {
			out := runCaddy(t, RunInput{URL: url, Options: options})
			if !out.Ok {
				t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
			}
			if len(out.Metrics) != 3 {
				t.Fatalf("应按全选输出三项，实得 %d", len(out.Metrics))
			}
		})
	}
}

func TestCaddyTreatsBadCountsAsZero(t *testing.T) {
	// 布尔、对象、负值与不可解析文本都按 0，不影响其余计数
	body := `[
    {"num_requests":true,"fails":{}},
    {"num_requests":-3,"fails":"many"},
    {"num_requests":10,"fails":null}
  ]`
	url := startCaddy(t, http.StatusOK, body)

	out := runCaddy(t, RunInput{URL: url})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if got := caddyNumber(t, metricByID(t, out.Metrics, "requests")); got != 10 {
		t.Fatalf("请求数应为 10，实得 %d", got)
	}
	if got := caddyNumber(t, metricByID(t, out.Metrics, "requests_failed")); got != 0 {
		t.Fatalf("失败数应为 0，实得 %d", got)
	}
}

func TestCaddyRejectsNonArrayPayload(t *testing.T) {
	for name, body := range map[string]string{
		"对象":  `{"upstreams":[]}`,
		"字符串": `"upstreams"`,
		"数字":  `42`,
	} {
		t.Run(name, func(t *testing.T) {
			url := startCaddy(t, http.StatusOK, body)

			out := runCaddy(t, RunInput{URL: url})
			if out.Ok {
				t.Fatal("顶层不是数组必须失败")
			}
			if out.Error != caddyStatsBadFields {
				t.Fatalf("失败文案应为 %q，实得 %q", caddyStatsBadFields, out.Error)
			}
		})
	}
}

func TestCaddyRejectsInvalidJSON(t *testing.T) {
	url := startCaddy(t, http.StatusOK, "<html>oops</html>")

	out := runCaddy(t, RunInput{URL: url})
	if out.Ok {
		t.Fatal("非 JSON 响应必须失败")
	}
	if out.Error != caddyStatsBadJSON {
		t.Fatalf("失败文案应为 %q，实得 %q", caddyStatsBadJSON, out.Error)
	}
	if strings.Contains(out.Error, "html") {
		t.Fatal("失败文案不得包含响应正文")
	}
}

func TestCaddyRejectsNonOKStatus(t *testing.T) {
	url := startCaddy(t, http.StatusInternalServerError, caddyTestUpstreams)

	out := runCaddy(t, RunInput{URL: url})
	if out.Ok {
		t.Fatal("非 2xx 必须失败")
	}
	if out.Error != caddyStatsFail {
		t.Fatalf("失败文案应为 %q，实得 %q", caddyStatsFail, out.Error)
	}
}

func TestCaddyRejectsInvalidTarget(t *testing.T) {
	out := runCaddy(t, RunInput{URL: "not-a-url"})
	if out.Ok {
		t.Fatal("非法目标地址必须失败")
	}
	if strings.Contains(out.Error, "not-a-url") {
		t.Fatalf("失败文案不得回显目标地址：%q", out.Error)
	}
}

func TestCaddyEmptyUpstreamListStillSucceeds(t *testing.T) {
	url := startCaddy(t, http.StatusOK, `[]`)

	out := runCaddy(t, RunInput{URL: url})
	if !out.Ok {
		t.Fatalf("空上游列表应成功，实得失败：%q", out.Error)
	}
	if got := caddyNumber(t, metricByID(t, out.Metrics, "upstreams")); got != 0 {
		t.Fatalf("上游数应为 0，实得 %d", got)
	}
}

func TestCaddyMetricsMatchJSONContract(t *testing.T) {
	// 字段名与前端契约逐字一致，不含多余键
	url := startCaddy(t, http.StatusOK, caddyTestUpstreams)

	out := runCaddy(t, RunInput{URL: url})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}

	payload, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	for _, want := range []string{`"ok":true`, `"id":"upstreams"`, `"label":"上游"`, `"id":"requests_failed"`} {
		if !strings.Contains(string(payload), want) {
			t.Fatalf("输出应包含 %s，实得 %s", want, payload)
		}
	}
	if strings.Contains(string(payload), `"sessions"`) {
		t.Fatalf("无会话时不得输出 sessions 字段：%s", payload)
	}
}
