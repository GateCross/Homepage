package adapters

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 起一个假自定义接口，回固定正文并记录收到的请求。
func startCustomAPI(t *testing.T, fake *fakeCustomAPI) string {
	t.Helper()
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		fake.requests++
		fake.method = r.Method
		fake.accept = r.Header.Get("Accept")
		fake.authorization = r.Header.Get("Authorization")

		if fake.handler != nil {
			fake.handler(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(customAPITestBody))
	})
	return server.URL
}

// 假接口收到的请求记录，供断言方法与请求头。
type fakeCustomAPI struct {
	handler       http.HandlerFunc
	requests      int
	method        string
	accept        string
	authorization string
}

// 默认响应：嵌套对象、数组与各种标量，覆盖所有取值格式。
const customAPITestBody = `{
  "stats": {"online": true, "ratio": 12.345, "storage": 1500000, "uptime": 3725},
  "items": [{"name": "first"}, {"name": "second"}],
  "title": "示例站点"
}`

// 执行一次适配器调用并规范结果；适配器层不应向外抛错。
func runCustomAPI(t *testing.T, input RunInput) ServiceWidgetResult {
	t.Helper()
	raw, err := customApiAdapter{}.Run(context.Background(), input)
	if err != nil {
		t.Fatalf("适配器不应返回底层错误：%v", err)
	}
	return Validate(raw)
}

// 构造一份只含单条映射的选项。
func customAPIOptionsWithMapping(mapping map[string]any) map[string]any {
	return map[string]any{"method": "GET", "mappings": []any{mapping}}
}

func TestCustomAPIAdapterIsRegistered(t *testing.T) {
	adapter, ok := Get("customapi")
	if !ok {
		t.Fatal("customapi 必须在初始化时登记到默认注册表")
	}
	if adapter.Type() != "customapi" {
		t.Fatalf("类型名应为 customapi，实得 %q", adapter.Type())
	}
}

func TestCustomAPIExtractsNestedValues(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})
	options := map[string]any{
		"method": "GET",
		"mappings": []any{
			map[string]any{"id": "online", "label": "在线", "path": "stats.online", "format": "text"},
			map[string]any{"id": "ratio", "label": "分享率", "path": "stats.ratio", "format": "number"},
			map[string]any{"id": "storage", "label": "存储", "path": "stats.storage", "format": "bytes"},
			map[string]any{"id": "uptime", "label": "运行时长", "path": "stats.uptime", "format": "duration"},
			map[string]any{"id": "ratioPercent", "label": "比例", "path": "stats.ratio", "format": "percent"},
			map[string]any{"id": "second", "label": "第二项", "path": "items.1.name", "format": "text"},
			map[string]any{"id": "title", "label": "标题", "field": "title", "format": "text"},
		},
	}

	out := runCustomAPI(t, RunInput{URL: url, Options: options})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(out.Metrics) != 7 {
		t.Fatalf("应有七项指标，实得 %d：%+v", len(out.Metrics), out.Metrics)
	}

	if got := metricByID(t, out.Metrics, "online"); got.Value != "true" {
		t.Fatalf("布尔应按文本输出，实得 %v", got.Value)
	}
	if got := metricByID(t, out.Metrics, "ratio"); metricNumber(t, got) != 12.345 {
		t.Fatalf("数值指标不符：%+v", got)
	}
	if got := metricByID(t, out.Metrics, "storage"); metricNumber(t, got) != 1.5 || got.Unit != "MB" {
		t.Fatalf("字节指标应按单位缩放：%+v", got)
	}
	if got := metricByID(t, out.Metrics, "uptime"); got.Value != "1小时2分5秒" {
		t.Fatalf("时长指标应为中文时长，实得 %v", got.Value)
	}
	if got := metricByID(t, out.Metrics, "ratioPercent"); got.Unit != "%" {
		t.Fatalf("百分比指标应带 %% 单位：%+v", got)
	}
	if got := metricByID(t, out.Metrics, "second"); got.Value != "second" {
		t.Fatalf("数组下标取值不符：%+v", got)
	}
	if got := metricByID(t, out.Metrics, "title"); got.Value != "示例站点" {
		t.Fatalf("field 应作为路径回退：%+v", got)
	}
}

func TestCustomAPIDefaultsMethodAndHeaders(t *testing.T) {
	fake := &fakeCustomAPI{}
	url := startCustomAPI(t, fake)

	out := runCustomAPI(t, RunInput{
		URL:     url,
		Options: map[string]any{"mappings": []any{map[string]any{"label": "在线", "path": "stats.online"}}},
	})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if fake.method != http.MethodGet {
		t.Fatalf("缺省方法应为 GET，实得 %q", fake.method)
	}
	if fake.accept != "application/json" {
		t.Fatalf("应默认带 Accept: application/json，实得 %q", fake.accept)
	}
}

func TestCustomAPISendsConfiguredHeaders(t *testing.T) {
	fake := &fakeCustomAPI{}
	url := startCustomAPI(t, fake)

	out := runCustomAPI(t, RunInput{
		URL: url,
		Options: map[string]any{
			"headers":  map[string]any{"Authorization": "Bearer token-value"},
			"mappings": []any{map[string]any{"label": "在线", "path": "stats.online"}},
		},
	})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if fake.authorization != "Bearer token-value" {
		t.Fatalf("请求头未送达，实得 %q", fake.authorization)
	}
}

func TestCustomAPIMissingPathIsUnavailable(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})

	out := runCustomAPI(t, RunInput{
		URL: url,
		Options: customAPIOptionsWithMapping(map[string]any{
			"id": "missing", "label": "缺失项", "path": "stats.notThere", "format": "number",
		}),
	})
	if !out.Ok {
		t.Fatalf("路径不存在不应拖垮整卡，实得失败：%q", out.Error)
	}
	metric := metricByID(t, out.Metrics, "missing")
	if metric.Status != MetricStatusUnavailable || metric.Value != "不可用" {
		t.Fatalf("缺失路径应降级为不可用：%+v", metric)
	}
}

func TestCustomAPIOutOfRangeIndexIsUnavailable(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})

	out := runCustomAPI(t, RunInput{
		URL: url,
		Options: customAPIOptionsWithMapping(map[string]any{
			"id": "item", "label": "越界项", "path": "items.9.name",
		}),
	})
	if !out.Ok {
		t.Fatalf("下标越界不应拖垮整卡，实得失败：%q", out.Error)
	}
	if got := metricByID(t, out.Metrics, "item"); got.Status != MetricStatusUnavailable {
		t.Fatalf("下标越界应降级为不可用：%+v", got)
	}
}

func TestCustomAPIIsolationBetweenMappings(t *testing.T) {
	// 单条失败只让该项不可用，其余照常输出
	url := startCustomAPI(t, &fakeCustomAPI{})
	options := map[string]any{
		"mappings": []any{
			map[string]any{"id": "ok", "label": "正常", "path": "stats.online"},
			map[string]any{"id": "missing", "label": "缺失", "path": "no.such.path"},
			map[string]any{"id": "badFormat", "label": "格式错", "path": "stats.ratio", "format": "weird"},
			map[string]any{"id": "notANumber", "label": "非数字", "path": "title", "format": "number"},
			map[string]any{"id": "obj", "label": "对象", "path": "stats", "format": "text"},
		},
	}

	out := runCustomAPI(t, RunInput{URL: url, Options: options})
	if !out.Ok {
		t.Fatalf("单条失败不应拖垮整卡，实得失败：%q", out.Error)
	}
	if got := metricByID(t, out.Metrics, "ok"); got.Status != MetricStatusOK {
		t.Fatalf("正常项应保持可用：%+v", got)
	}
	for _, id := range []string{"missing", "notANumber", "obj"} {
		if got := metricByID(t, out.Metrics, id); got.Status != MetricStatusUnavailable {
			t.Fatalf("%s 应降级为不可用：%+v", id, got)
		}
	}
	// 未知格式按不可用处理，而不是丢弃该条
	if got := metricByID(t, out.Metrics, "badFormat"); got.Status != MetricStatusUnavailable {
		t.Fatalf("未知格式应标记不可用：%+v", got)
	}
}

func TestCustomAPIGeneratesDefaultLabelsAndIDs(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})

	out := runCustomAPI(t, RunInput{
		URL: url,
		Options: map[string]any{
			"mappings": []any{
				map[string]any{"path": "stats.online"},
				map[string]any{"path": "stats.ratio"},
				map[string]any{"id": "dup", "label": "重复", "path": "stats.online"},
				map[string]any{"id": "dup", "label": "重复二", "path": "stats.online"},
			},
		},
	})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(out.Metrics) != 4 {
		t.Fatalf("应有四项指标，实得 %d：%+v", len(out.Metrics), out.Metrics)
	}
	if got := out.Metrics[0]; got.ID != "mapping_0" || got.Label != "指标1" {
		t.Fatalf("缺省标识与标签不符：%+v", got)
	}
	if got := out.Metrics[1]; got.ID != "mapping_1" || got.Label != "指标2" {
		t.Fatalf("缺省标识与标签不符：%+v", got)
	}
	// 重复标识加下标保持唯一，避免整卡被判无效
	if out.Metrics[2].ID == out.Metrics[3].ID {
		t.Fatalf("重复标识应被改写：%q 与 %q", out.Metrics[2].ID, out.Metrics[3].ID)
	}
	if out.Metrics[3].ID != "dup_3" {
		t.Fatalf("重复标识应追加下标，实得 %q", out.Metrics[3].ID)
	}
}

func TestCustomAPIAddsCJKPrefixToAsciiLabel(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})

	out := runCustomAPI(t, RunInput{
		URL:     url,
		Options: customAPIOptionsWithMapping(map[string]any{"label": "online", "path": "stats.online"}),
	})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if got := out.Metrics[0].Label; got != "指标 online" {
		t.Fatalf("无中文标签应补前缀，实得 %q", got)
	}
}

func TestCustomAPISkipsNonObjectMappings(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})

	out := runCustomAPI(t, RunInput{
		URL: url,
		Options: map[string]any{
			"mappings": []any{
				"not-an-object",
				42,
				map[string]any{"label": "在线", "path": "stats.online"},
			},
		},
	})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}
	if len(out.Metrics) != 1 {
		t.Fatalf("非对象映射应跳过，实得 %d 项：%+v", len(out.Metrics), out.Metrics)
	}
}

func TestCustomAPIRejectsInvalidJSON(t *testing.T) {
	fake := &fakeCustomAPI{
		handler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("<html>oops</html>"))
		},
	}
	url := startCustomAPI(t, fake)

	out := runCustomAPI(t, RunInput{
		URL:     url,
		Options: customAPIOptionsWithMapping(map[string]any{"label": "在线", "path": "stats.online"}),
	})
	if out.Ok {
		t.Fatal("非 JSON 响应必须失败")
	}
	if out.Error != customAPIRequestBadJSON {
		t.Fatalf("失败文案应为 %q，实得 %q", customAPIRequestBadJSON, out.Error)
	}
	if strings.Contains(out.Error, "html") {
		t.Fatal("失败文案不得包含响应正文")
	}
}

func TestCustomAPIRejectsNonOKStatus(t *testing.T) {
	fake := &fakeCustomAPI{
		handler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
	}
	url := startCustomAPI(t, fake)

	out := runCustomAPI(t, RunInput{
		URL:     url,
		Options: customAPIOptionsWithMapping(map[string]any{"label": "在线", "path": "stats.online"}),
	})
	if out.Ok {
		t.Fatal("非 2xx 必须失败")
	}
	if out.Error != customAPIRequestFail {
		t.Fatalf("失败文案应为 %q，实得 %q", customAPIRequestFail, out.Error)
	}
}

func TestCustomAPIRejectsInvalidOptions(t *testing.T) {
	cases := []struct {
		name    string
		options any
		want    string
	}{
		{"options 不是对象", "method=GET", "Custom API 的 options 必须为对象"},
		{"method 非字符串", map[string]any{"method": 1}, "Custom API 的 method 必须为字符串"},
		{"method 非 GET", map[string]any{"method": "POST"}, customAPIMethodUnsupported},
		{"headers 非对象", map[string]any{"headers": []any{"a"}}, "Custom API 的 headers 必须为对象"},
		{"请求头值非字符串", map[string]any{"headers": map[string]any{"X-Token": 1}}, "Custom API 请求头 X-Token 的值必须为字符串"},
		{"mappings 非数组", map[string]any{"mappings": "stats.online"}, "Custom API 的 mappings 必须为数组"},
	}

	fake := &fakeCustomAPI{}
	url := startCustomAPI(t, fake)
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			before := fake.requests
			out := runCustomAPI(t, RunInput{URL: url, Options: testCase.options})
			if out.Ok {
				t.Fatal("选项非法必须返回失败结果")
			}
			if out.Error != testCase.want {
				t.Fatalf("失败文案应为 %q，实得 %q", testCase.want, out.Error)
			}
			if fake.requests != before {
				t.Fatalf("选项非法时不得发出请求，实际增加 %d 次", fake.requests-before)
			}
		})
	}
}

// 配置加载产出的是 []map[string]any，与 JSON 解码的 []any 形态不同，两者都必须接受。
func TestCustomAPIAcceptsMappingsFromConfigLoader(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want int
	}{
		{"loader 形态 []map[string]any", []map[string]any{{"field": "online"}, {"field": "count"}}, 2},
		{"JSON 形态 []any", []any{map[string]any{"field": "online"}}, 1},
		{"空数组", []map[string]any{}, 0},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			list, err := parseCustomAPIMappings(testCase.raw)
			if err != nil {
				t.Fatalf("不应报错：%v", err)
			}
			if len(list) != testCase.want {
				t.Fatalf("条目数应为 %d，实得 %d", testCase.want, len(list))
			}
		})
	}

	// 非数组仍按契约拒绝
	if _, err := parseCustomAPIMappings("not-a-list"); err == nil {
		t.Fatal("非数组必须报错")
	}
}

// 端到端：loader 形态的 mappings 必须真的抽出指标，而不是整卡失败。
func TestCustomAPIRunsWithConfigLoaderMappings(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{
		handler: func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"stats":{"online":7}}`))
		},
	})

	out := runCustomAPI(t, RunInput{
		URL: url,
		Options: map[string]any{
			"method": "GET",
			"mappings": []map[string]any{
				{"id": "online", "label": "在线", "path": "stats.online"},
			},
		},
	})
	if !out.Ok {
		t.Fatalf("loader 形态的 mappings 不应导致失败：%q", out.Error)
	}
	if len(out.Metrics) != 1 || out.Metrics[0].Label != "在线" {
		t.Fatalf("应抽出 1 项指标，实得 %+v", out.Metrics)
	}
}

func TestCustomAPIAcceptsMissingOptions(t *testing.T) {
	// 选项缺省时按 GET 与空映射继续，返回空指标数组而非失败
	url := startCustomAPI(t, &fakeCustomAPI{})

	out := runCustomAPI(t, RunInput{URL: url})
	if !out.Ok {
		t.Fatalf("缺少选项不应失败：%q", out.Error)
	}
	if len(out.Metrics) != 0 {
		t.Fatalf("空映射应输出空指标数组，实得 %+v", out.Metrics)
	}

	payload, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if !strings.Contains(string(payload), `"metrics":[]`) {
		t.Fatalf("成功结果必须输出空指标数组：%s", payload)
	}
}

func TestCustomAPIPathParsing(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"stats.online", true},
		{"items.0.name", true},
		{"a_b.c_d", true},
		{"指标.数值", true},
		{"", false},
		{"   ", false},
		{"a..b", false},
		{"__proto__", false},
		{"a.constructor.b", false},
		{"a.PROTOTYPE", false},
		{"items.01", false},
		{"a-b.c_d", false},
		{"a[b]", false},
		{"a b", false},
		{"a+b", false},
		{"a->b", false},
		{"1name", false},
		{"-lead", false},
	}

	for _, testCase := range cases {
		if _, ok := parseCustomAPIDotPath(testCase.path); ok != testCase.want {
			t.Fatalf("%q 的路径判定应为 %v，实得 %v", testCase.path, testCase.want, ok)
		}
	}
}

func TestCustomAPIRejectsInvalidPathInMapping(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})

	for name, mapping := range map[string]map[string]any{
		"路径缺失":  {"id": "x", "label": "缺路径"},
		"表达式路径": {"id": "x", "label": "表达式", "path": "stats[0]"},
		"原型链路径": {"id": "x", "label": "原型链", "path": "__proto__.x"},
	} {
		t.Run(name, func(t *testing.T) {
			out := runCustomAPI(t, RunInput{URL: url, Options: customAPIOptionsWithMapping(mapping)})
			if !out.Ok {
				t.Fatalf("单条路径非法不应拖垮整卡：%q", out.Error)
			}
			metric := metricByID(t, out.Metrics, "x")
			if metric.Status != MetricStatusUnavailable {
				t.Fatalf("路径非法应降级为不可用：%+v", metric)
			}
		})
	}
}

func TestCustomAPINeverLeaksHeadersOrURL(t *testing.T) {
	// 服务端把请求头值回显到正文里，仍然只能出现在指标值而不是失败文案
	fake := &fakeCustomAPI{
		handler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("auth=" + r.Header.Get("Authorization")))
		},
	}
	url := startCustomAPI(t, fake)

	out := runCustomAPI(t, RunInput{
		URL: url,
		Options: map[string]any{
			"headers":  map[string]any{"Authorization": "Bearer leaked-token"},
			"mappings": []any{map[string]any{"label": "在线", "path": "stats.online"}},
		},
	})
	if out.Ok {
		t.Fatal("非 2xx 必须失败")
	}
	secrets := map[string]string{"Authorization": "Bearer leaked-token"}
	if ContainsAnySecret(out.Error, secrets) {
		t.Fatalf("失败文案不得含请求头值：%q", out.Error)
	}
	if strings.Contains(out.Error, "127.0.0.1") {
		t.Fatalf("失败文案不得含目标地址：%q", out.Error)
	}
}

func TestCustomAPIMetricsMatchJSONContract(t *testing.T) {
	url := startCustomAPI(t, &fakeCustomAPI{})

	out := runCustomAPI(t, RunInput{
		URL:     url,
		Options: customAPIOptionsWithMapping(map[string]any{"id": "ratio", "label": "分享率", "path": "stats.ratio", "format": "percent"}),
	})
	if !out.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", out.Error)
	}

	payload, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	for _, want := range []string{`"ok":true`, `"id":"ratio"`, `"label":"分享率"`, `"unit":"%"`, `"status":"ok"`} {
		if !strings.Contains(string(payload), want) {
			t.Fatalf("输出应包含 %s，实得 %s", want, payload)
		}
	}
}
