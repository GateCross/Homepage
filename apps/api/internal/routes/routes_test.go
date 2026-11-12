package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gatecross/homepage/api/internal/adapters"
	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
	"github.com/gatecross/homepage/api/internal/httpapi"
	"github.com/gatecross/homepage/api/internal/probe"
	"github.com/gatecross/homepage/api/internal/providers"
)

// 带一个已登记探测、组件与信息目标的允许列表。
func testAllowList() *config.AllowList {
	allowList := config.NewAllowList()
	allowList.HTTPProbeTargets["prb_known"] = config.HTTPProbeTarget{
		URL:       "https://example.com",
		TimeoutMs: 5000,
	}
	allowList.WidgetTargets["wgt_known"] = config.WidgetTarget{
		Type:    "customapi",
		URL:     "https://example.com/api",
		Secrets: map[string]string{"token": "s3cr3t-token"},
		Options: map[string]any{},
	}
	allowList.InfoTargets["inf_weather"] = config.InfoTarget{
		Type:    "openmeteo",
		Options: map[string]any{"cityId": "101020100", "location": "上海"},
	}
	allowList.InfoTargets["inf_resources"] = config.InfoTarget{
		Type:    "resources",
		Options: map[string]any{"cpu": true, "memory": true},
	}
	allowList.InfoTargets["inf_clock"] = config.InfoTarget{Type: "datetime"}
	allowList.InfoTargets["inf_unknown"] = config.InfoTarget{Type: "nonexistent"}
	return allowList
}

// 出网计数桩：所有回调都自增计数，便于断言未登记目标 0 次出网。
type outboundCounter struct {
	probe     atomic.Int64
	widget    atomic.Int64
	weather   atomic.Int64
	resources atomic.Int64
}

// 组装全部回调都指向计数桩的处理器。
func newTestHandler(counter *outboundCounter) *Handler {
	return NewHandler(Deps{
		AllowList: func(*http.Request) *config.AllowList { return testAllowList() },
		Probe: func(context.Context, string, int, []domain.StatusRange) probe.Result {
			counter.probe.Add(1)
			code := 200
			latency := int64(12)
			return probe.Result{Status: probe.StatusReachable, HTTPCode: &code, LatencyMs: &latency}
		},
		RunWidget: func(context.Context, adapters.RunRequest) adapters.ServiceWidgetResult {
			counter.widget.Add(1)
			return adapters.SuccessResult([]adapters.Metric{{
				ID: "up", Label: "在线", Value: "是", Status: adapters.MetricStatusOK,
			}}, nil)
		},
		FetchWeather: func(context.Context, providers.OpenMeteoTarget) (providers.OpenMeteoInfoResponse, error) {
			counter.weather.Add(1)
			text := "晴"
			return providers.OpenMeteoInfoResponse{TemperatureC: 21.5, ConditionText: &text}, nil
		},
		CollectResources: func(context.Context, providers.ResourcesTarget) providers.ResourcesInfoResponse {
			counter.resources.Add(1)
			percent := 42.0
			return providers.ResourcesInfoResponse{Items: []providers.ResourceItem{{
				ID: "cpu", Label: "CPU", Percent: &percent,
			}}}
		},
	})
}

// 发一次 GET 并解出状态码与响应体。
func serve(handler http.Handler, path string) (int, map[string]any) {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))

	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		payload = nil
	}
	return recorder.Code, payload
}

// 已登记目标正常返回，字段名与契约一致。
func TestHandlerServesRegisteredTargets(t *testing.T) {
	counter := &outboundCounter{}
	handler := newTestHandler(counter)

	code, body := serve(handler, ProbePrefix+"prb_known")
	if code != http.StatusOK || body["status"] != "reachable" {
		t.Fatalf("探测响应不符：%d %+v", code, body)
	}

	code, body = serve(handler, WidgetsPrefix+"wgt_known")
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("组件响应不符：%d %+v", code, body)
	}
	if _, ok := body["metrics"].([]any); !ok {
		t.Fatalf("成功组件必须带 metrics 数组：%+v", body)
	}

	code, body = serve(handler, InfoPrefix+"inf_weather")
	if code != http.StatusOK || body["temperatureC"] != 21.5 {
		t.Fatalf("天气响应不符：%d %+v", code, body)
	}

	code, body = serve(handler, InfoPrefix+"inf_resources")
	if code != http.StatusOK {
		t.Fatalf("资源响应状态不符：%d %+v", code, body)
	}
	if _, ok := body["items"].([]any); !ok {
		t.Fatalf("资源响应必须带 items 数组：%+v", body)
	}

	if counter.probe.Load() != 1 || counter.widget.Load() != 1 ||
		counter.weather.Load() != 1 || counter.resources.Load() != 1 {
		t.Fatalf("已登记目标应各出网一次：%+v", counter)
	}
}

// 未登记目标一律 403，且 0 次出网。
func TestHandlerRejectsUnregisteredTargets(t *testing.T) {
	counter := &outboundCounter{}
	handler := newTestHandler(counter)

	paths := []string{
		ProbePrefix + "prb_missing",
		WidgetsPrefix + "wgt_missing",
		InfoPrefix + "inf_missing",
	}
	for _, path := range paths {
		code, body := serve(handler, path)
		if code != http.StatusForbidden {
			t.Errorf("%s 状态码 = %d，期望 403", path, code)
			continue
		}
		if body["ok"] != false {
			t.Errorf("%s 应返回失败信封：%+v", path, body)
		}
	}

	// 非法转义与空白 ID 同样按未登记处理
	rawRequests := []*http.Request{
		{Method: http.MethodGet, URL: &url.URL{Path: ProbePrefix + "%zz"}},
		{Method: http.MethodGet, URL: &url.URL{Path: WidgetsPrefix + "%20"}},
	}
	for _, request := range rawRequests {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Errorf("%s 状态码 = %d，期望 403", request.URL.Path, recorder.Code)
		}
	}
	if counter.probe.Load() != 0 || counter.widget.Load() != 0 ||
		counter.weather.Load() != 0 || counter.resources.Load() != 0 {
		t.Fatalf("未登记目标不得出网：%+v", counter)
	}
}

// datetime 只在前端格式化，类型不受支持的信息组件同样 403。
func TestHandlerRejectsNonDataInfoTypes(t *testing.T) {
	counter := &outboundCounter{}
	handler := newTestHandler(counter)

	for _, path := range []string{InfoPrefix + "inf_clock", InfoPrefix + "inf_unknown"} {
		code, body := serve(handler, path)
		if code != http.StatusForbidden {
			t.Errorf("%s 状态码 = %d，期望 403：%+v", path, code, body)
		}
	}
	if counter.weather.Load() != 0 {
		t.Fatal("非数据类信息组件不得出网")
	}
}

// 响应里出现允许列表中的敏感值时改发 INTERNAL，绝不泄露。
func TestHandlerBlocksSecretLeak(t *testing.T) {
	allowList := config.NewAllowList()
	allowList.WidgetTargets["wgt_leak"] = config.WidgetTarget{
		Type:    "customapi",
		URL:     "https://example.com/api",
		Secrets: map[string]string{"token": "s3cr3t-token"},
	}
	handler := NewHandler(Deps{
		AllowList: func(*http.Request) *config.AllowList { return allowList },
		RunWidget: func(context.Context, adapters.RunRequest) adapters.ServiceWidgetResult {
			// 适配器本应过滤，这里模拟漏网情况
			return adapters.SuccessResult([]adapters.Metric{{
				ID: "token", Label: "令牌", Value: "s3cr3t-token",
			}}, nil)
		},
	})

	code, body := serve(handler, WidgetsPrefix+"wgt_leak")
	if code != http.StatusInternalServerError {
		t.Fatalf("命中敏感值应返回 500，实得 %d：%+v", code, body)
	}
	if body["ok"] != false {
		t.Fatalf("命中敏感值应返回失败信封：%+v", body)
	}
	encoded, _ := json.Marshal(body)
	if strings.Contains(string(encoded), "s3cr3t-token") {
		t.Fatalf("响应不得包含敏感值：%s", encoded)
	}
}

// 适配器业务失败仍以 200 + ok:false 返回；失败文案命中敏感值时换成固定文案。
func TestHandlerWidgetFailureStaysOK(t *testing.T) {
	allowList := config.NewAllowList()
	allowList.WidgetTargets["wgt_fail"] = config.WidgetTarget{Type: "customapi", URL: "https://example.com"}
	allowList.WidgetTargets["wgt_leak"] = config.WidgetTarget{
		Type:    "customapi",
		URL:     "https://example.com",
		Secrets: map[string]string{"token": "s3cr3t-token"},
	}
	handler := NewHandler(Deps{
		AllowList: func(*http.Request) *config.AllowList { return allowList },
		RunWidget: func(_ context.Context, request adapters.RunRequest) adapters.ServiceWidgetResult {
			if request.URL == "https://example.com" && len(request.Secrets) > 0 {
				return adapters.FailureResult("token 无效：s3cr3t-token")
			}
			return adapters.FailureResult("服务组件请求失败")
		},
	})

	code, body := serve(handler, WidgetsPrefix+"wgt_fail")
	if code != http.StatusOK || body["ok"] != false {
		t.Fatalf("业务失败应 200 + ok:false：%d %+v", code, body)
	}

	code, body = serve(handler, WidgetsPrefix+"wgt_leak")
	if code != http.StatusOK || body["ok"] != false {
		t.Fatalf("命中敏感值仍以 200 返回：%d %+v", code, body)
	}
	if text, _ := body["error"].(string); strings.Contains(text, "s3cr3t-token") {
		t.Fatalf("失败文案不得泄露敏感值：%q", text)
	}
}

// 非 GET 与多段路径按 JSON 404 处理，不回退到 SPA。
func TestHandlerRejectsUnsupportedRequests(t *testing.T) {
	handler := newTestHandler(&outboundCounter{})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, ProbePrefix+"prb_known", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("非 GET 状态码 = %d，期望 404", recorder.Code)
	}

	for _, path := range []string{"/api/probe/", "/api/widgets/a/b", "/api/other/x"} {
		code, body := serve(handler, path)
		if code != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404", path, code)
		}
		if body == nil || body["ok"] != false {
			t.Fatalf("%s 应返回失败信封：%+v", path, body)
		}
	}
}

// 未注入能力时按内部错误响应，而不是 panic。
func TestHandlerWithoutDependencies(t *testing.T) {
	handler := NewHandler(Deps{
		AllowList: func(*http.Request) *config.AllowList { return testAllowList() },
	})

	for _, path := range []string{
		ProbePrefix + "prb_known",
		WidgetsPrefix + "wgt_known",
		InfoPrefix + "inf_weather",
		InfoPrefix + "inf_resources",
	} {
		code, _ := serve(handler, path)
		if code != http.StatusInternalServerError {
			t.Errorf("%s 缺少依赖时状态码 = %d，期望 500", path, code)
		}
	}
}

// 空允许列表：所有数据目标都按未登记处理。
func TestHandlerWithEmptyAllowList(t *testing.T) {
	counter := &outboundCounter{}
	handler := NewHandler(Deps{
		AllowList: func(*http.Request) *config.AllowList { return config.NewAllowList() },
		Probe: func(context.Context, string, int, []domain.StatusRange) probe.Result {
			counter.probe.Add(1)
			return probe.Result{Status: probe.StatusUnreachable}
		},
	})

	code, _ := serve(handler, ProbePrefix+"prb_known")
	if code != http.StatusForbidden {
		t.Fatalf("空允许列表下状态码 = %d，期望 403", code)
	}
	if counter.probe.Load() != 0 {
		t.Fatal("空允许列表不得出网")
	}

	// 未注入 AllowList 回调时同样按空列表处理
	handler = NewHandler(Deps{})
	code, _ = serve(handler, WidgetsPrefix+"wgt_known")
	if code != http.StatusForbidden {
		t.Fatalf("未注入允许列表时状态码 = %d，期望 403", code)
	}
}

// 天气目标只接受 6–12 位纯数字城市编码与非空地点名。
func TestParseWeatherTarget(t *testing.T) {
	cases := []struct {
		name    string
		options any
		ok      bool
	}{
		{name: "合法", options: map[string]any{"cityId": "101020100", "location": "上海"}, ok: true},
		{name: "非映射", options: "101020100", ok: false},
		{name: "非数字", options: map[string]any{"cityId": "shanghai", "location": "上海"}, ok: false},
		{name: "过短", options: map[string]any{"cityId": "1010", "location": "上海"}, ok: false},
		{name: "缺地点", options: map[string]any{"cityId": "101020100", "location": "  "}, ok: false},
		{name: "缺类型", options: map[string]any{"location": "上海"}, ok: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			target, ok := parseWeatherTarget(testCase.options)
			if ok != testCase.ok {
				t.Fatalf("parseWeatherTarget = %v，期望 %v", ok, testCase.ok)
			}
			if ok && (target.CityID == "" || target.Location == "") {
				t.Fatalf("解析结果不完整：%+v", target)
			}
		})
	}
}

// 天气失败按来源映射状态码：超时 504，出站失败 502，其余 500。
func TestWeatherFailureStatus(t *testing.T) {
	allowList := config.NewAllowList()
	allowList.InfoTargets["inf_weather"] = config.InfoTarget{
		Type:    "openmeteo",
		Options: map[string]any{"cityId": "101020100", "location": "上海"},
	}
	cases := []struct {
		err    error
		status int
	}{
		{err: providers.ErrWeatherTimeout, status: http.StatusGatewayTimeout},
		{err: providers.ErrWeatherUnavailable, status: http.StatusBadGateway},
		{err: providers.ErrWeatherInvalid, status: http.StatusBadGateway},
		{err: context.DeadlineExceeded, status: http.StatusInternalServerError},
	}
	for _, testCase := range cases {
		handler := NewHandler(Deps{
			AllowList: func(*http.Request) *config.AllowList { return allowList },
			FetchWeather: func(context.Context, providers.OpenMeteoTarget) (providers.OpenMeteoInfoResponse, error) {
				return providers.OpenMeteoInfoResponse{}, testCase.err
			},
		})
		code, _ := serve(handler, InfoPrefix+"inf_weather")
		if code != testCase.status {
			t.Errorf("%v 应映射为 %d，实得 %d", testCase.err, testCase.status, code)
		}
	}
}

// 前缀匹配必须整段对齐：/api/probe 与 /api/probe/ 都不算目标。
func TestCutSegment(t *testing.T) {
	cases := map[string]bool{
		"prb_1": true,
		"a/b":   false,
		"":      false,
	}
	for rest, expected := range cases {
		if _, ok := cutSegment(ProbePrefix+rest, ProbePrefix); ok != expected {
			t.Errorf("cutSegment(%q) = %v，期望 %v", rest, ok, expected)
		}
	}
	if _, ok := cutSegment("/api/other/x", ProbePrefix); ok {
		t.Error("不匹配的前缀不得命中")
	}
}

// 未注入 AllowList 时不 panic，直接按未授权处理。
func TestCurrentAllowListWithoutCallback(t *testing.T) {
	deps := Deps{}
	if allowList := currentAllowList(deps, httptest.NewRequest(http.MethodGet, "/", nil)); allowList != nil {
		t.Fatalf("未注入回调时应返回 nil：%+v", allowList)
	}
}

// 保证 httpapi 常量可用：错误码取值与前端契约一致。
var _ = httpapi.CodeForbidden
