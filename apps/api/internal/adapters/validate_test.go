package adapters

import (
	"encoding/json"
	"math"
	"testing"
)

func TestValidateAcceptsWellFormedStruct(t *testing.T) {
	progress := 42.5
	raw := ServiceWidgetResult{
		Ok:      true,
		Metrics: []Metric{{ID: "download", Label: "下载", Value: 1.5, Unit: "MB/s", Status: MetricStatusOK}},
		Sessions: []SessionSummary{
			{ID: "s1", Title: "示例影片", User: "alice", Episode: "S01E02", Progress: &progress},
		},
	}

	result := Validate(raw)
	if !result.Ok {
		t.Fatalf("合法结果不应降级：%q", result.Error)
	}
	if len(result.Metrics) != 1 || result.Metrics[0].Unit != "MB/s" {
		t.Fatalf("指标应保留：%+v", result.Metrics)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].Progress == nil {
		t.Fatalf("会话应保留：%+v", result.Sessions)
	}
}

func TestValidateRejectsInvalidMetrics(t *testing.T) {
	cases := map[string][]Metric{
		"空标识":   {{ID: "", Label: "下载", Value: 1}},
		"空标签":   {{ID: "download", Label: "", Value: 1}},
		"标签无中文": {{ID: "download", Label: "download", Value: 1}},
		"值为空":   {{ID: "download", Label: "下载", Value: nil}},
		"值为对象":  {{ID: "download", Label: "下载", Value: map[string]any{"a": 1}}},
		"值为NaN": {{ID: "download", Label: "下载", Value: math.NaN()}},
		"值无穷":   {{ID: "download", Label: "下载", Value: math.Inf(1)}},
		"标识重复": {
			{ID: "download", Label: "下载", Value: 1},
			{ID: "download", Label: "上传", Value: 2},
		},
		"状态非法": {{ID: "download", Label: "下载", Value: 1, Status: "broken"}},
	}

	for name, metrics := range cases {
		result := Validate(ServiceWidgetResult{Ok: true, Metrics: metrics})
		if result.Ok {
			t.Fatalf("%s：应降级为失败", name)
		}
		if result.Error != InvalidWidgetResultError {
			t.Fatalf("%s：文案应为 %q，实得 %q", name, InvalidWidgetResultError, result.Error)
		}
	}
}

func TestValidateNormalizesMetricFields(t *testing.T) {
	raw := ServiceWidgetResult{
		Ok: true,
		Metrics: []Metric{
			{ID: "  download  ", Label: " 下载 ", Value: 1.5, Unit: " MB/s ", Status: " ok "},
			{ID: "flag", Label: "在线", Value: true},
		},
	}

	result := Validate(raw)
	if !result.Ok {
		t.Fatalf("应通过校验：%q", result.Error)
	}
	if result.Metrics[0].ID != "download" || result.Metrics[0].Unit != "MB/s" || result.Metrics[0].Status != MetricStatusOK {
		t.Fatalf("字段应去空白：%+v", result.Metrics[0])
	}
	if got, ok := result.Metrics[1].Value.(int); !ok || got != 1 {
		t.Fatalf("布尔值应转成 1，实得 %#v", result.Metrics[1].Value)
	}
}

func TestValidateAcceptsExtendedCJKLabels(t *testing.T) {
	// 扩展 A 区（0x3400–0x9FFF）也算中文
	raw := ServiceWidgetResult{Ok: true, Metrics: []Metric{{ID: "x", Label: "㐀", Value: 1}}}
	if result := Validate(raw); !result.Ok {
		t.Fatalf("扩展 A 区汉字应算中文标签：%q", result.Error)
	}
}

func TestValidateRejectsInvalidSessions(t *testing.T) {
	cases := map[string]SessionSummary{
		"空标识":  {ID: "", Title: "示例"},
		"空标题":  {ID: "s1", Title: ""},
		"进度为负": {ID: "s1", Title: "示例", Progress: floatPtr(-1)},
		"进度超百": {ID: "s1", Title: "示例", Progress: floatPtr(100.5)},
	}

	for name, session := range cases {
		result := Validate(ServiceWidgetResult{Ok: true, Metrics: okMetrics(), Sessions: []SessionSummary{session}})
		if result.Ok {
			t.Fatalf("%s：应降级为失败", name)
		}
	}
}

func TestValidateCapsSessionsAtFive(t *testing.T) {
	sessions := make([]SessionSummary, 0, 8)
	for index := 0; index < 8; index++ {
		sessions = append(sessions, SessionSummary{ID: "s" + string(rune('0'+index)), Title: "示例"})
	}

	result := Validate(ServiceWidgetResult{Ok: true, Metrics: okMetrics(), Sessions: sessions})
	if !result.Ok {
		t.Fatalf("应通过校验：%q", result.Error)
	}
	if len(result.Sessions) != MaxSessionSummaries {
		t.Fatalf("会话应截到 %d 条，实得 %d", MaxSessionSummaries, len(result.Sessions))
	}
}

func TestValidateKeepsFailureMessage(t *testing.T) {
	result := Validate(FailureResult("qBittorrent 登录失败"))
	if result.Ok {
		t.Fatal("失败结果不应变成成功")
	}
	if result.Error != "qBittorrent 登录失败" {
		t.Fatalf("失败文案应保留，实得 %q", result.Error)
	}
}

func TestValidateFillsMissingFailureMessage(t *testing.T) {
	result := Validate(ServiceWidgetResult{Ok: false})
	if result.Ok {
		t.Fatal("失败结果不应变成成功")
	}
	if result.Error != InvalidWidgetResultError {
		t.Fatalf("空文案应兜底，实得 %q", result.Error)
	}
}

func TestValidateRejectsUnrecognizedShapes(t *testing.T) {
	for _, raw := range []any{
		nil,
		"a string",
		42,
		[]Metric{{ID: "download", Label: "下载", Value: 1}},
		(*ServiceWidgetResult)(nil),
	} {
		result := Validate(raw)
		if result.Ok {
			t.Fatalf("%T 应被判为非法输出", raw)
		}
		if result.Error != InvalidWidgetResultError {
			t.Fatalf("%T 文案不符：%q", raw, result.Error)
		}
	}
}

func TestValidateParsesMapResult(t *testing.T) {
	raw := map[string]any{
		"ok": true,
		"metrics": []any{
			map[string]any{"id": "users", "label": "用户", "value": float64(3)},
			map[string]any{"id": "storage", "label": "存储", "value": 1.25, "unit": "TB", "status": "ok"},
		},
		"sessions": []any{
			map[string]any{"id": "s1", "title": "示例", "progress": float64(30)},
		},
	}

	result := Validate(raw)
	if !result.Ok {
		t.Fatalf("合法 map 结果不应降级：%q", result.Error)
	}
	if len(result.Metrics) != 2 {
		t.Fatalf("指标数量不符：%+v", result.Metrics)
	}
	if result.Metrics[1].Unit != "TB" {
		t.Fatalf("单位应保留：%+v", result.Metrics[1])
	}
	if len(result.Sessions) != 1 || result.Sessions[0].Progress == nil {
		t.Fatalf("会话应保留：%+v", result.Sessions)
	}
}

func TestValidateRejectsMalformedMapResult(t *testing.T) {
	cases := map[string]map[string]any{
		"缺 ok":   {"metrics": []any{}},
		"ok 非布尔": {"ok": "true", "metrics": []any{}},
		"成功缺指标":  {"ok": true},
		"指标非数组":  {"ok": true, "metrics": "x"},
		"指标项非对象": {"ok": true, "metrics": []any{"x"}},
		"指标缺值":   {"ok": true, "metrics": []any{map[string]any{"id": "a", "label": "下载"}}},
		"会话非数组":  {"ok": true, "metrics": []any{}, "sessions": "x"},
		"失败无文案":  {"ok": false},
		"进度非数值":  {"ok": true, "metrics": []any{}, "sessions": []any{map[string]any{"id": "s", "title": "示例", "progress": "30"}}},
	}

	for name, payload := range cases {
		result := Validate(payload)
		if result.Ok {
			t.Fatalf("%s：应降级为失败", name)
		}
		if result.Error != InvalidWidgetResultError {
			t.Fatalf("%s：文案不符：%q", name, result.Error)
		}
	}
}

func TestValidateParsesMapFailure(t *testing.T) {
	result := Validate(map[string]any{"ok": false, "error": "Emby 请求失败"})
	if result.Ok {
		t.Fatal("失败 map 不应变成成功")
	}
	if result.Error != "Emby 请求失败" {
		t.Fatalf("失败文案应保留，实得 %q", result.Error)
	}
}

func TestResultMarshalMatchesContract(t *testing.T) {
	success, err := json.Marshal(SuccessResult(okMetrics(), nil))
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	wantSuccess := `{"ok":true,"metrics":[{"id":"download","label":"下载","value":1.5,"unit":"MB/s","status":"ok"}]}`
	if string(success) != wantSuccess {
		t.Fatalf("成功形态不符：\n实得 %s\n期望 %s", success, wantSuccess)
	}

	failure, err := json.Marshal(FailureResult("Emby 请求失败"))
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	wantFailure := `{"ok":false,"error":"Emby 请求失败"}`
	if string(failure) != wantFailure {
		t.Fatalf("失败形态不符：\n实得 %s\n期望 %s", failure, wantFailure)
	}
}

func TestResultMarshalKeepsEmptyMetricsArray(t *testing.T) {
	payload, err := json.Marshal(ServiceWidgetResult{Ok: true})
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if string(payload) != `{"ok":true,"metrics":[]}` {
		t.Fatalf("成功形态的指标必须是数组而不是 null：%s", payload)
	}
}

func TestResultMarshalIncludesSessions(t *testing.T) {
	result := SuccessResult(okMetrics(), []SessionSummary{{ID: "s1", Title: "示例"}})
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("回读失败：%v", err)
	}
	sessions, ok := decoded["sessions"].([]any)
	if !ok || len(sessions) != 1 {
		t.Fatalf("会话字段不符：%s", payload)
	}
	// 未设置的字段不得出现
	if _, exists := decoded["error"]; exists {
		t.Fatalf("成功形态不应出现 error 字段：%s", payload)
	}
}

func TestValidateMetricsDetectsDuplicates(t *testing.T) {
	metrics := []Metric{
		{ID: "a", Label: "下载", Value: 1},
		{ID: "a", Label: "上传", Value: 2},
	}
	if ValidateMetrics(metrics) {
		t.Fatal("重复标识应判定为非法")
	}
	if !ValidateMetrics(okMetrics()) {
		t.Fatal("合法指标列表应通过")
	}
	if !ValidateMetrics(nil) {
		t.Fatal("空指标列表应通过，由业务适配器决定是否允许")
	}
}

func TestHasCJK(t *testing.T) {
	if !HasCJK("下载") {
		t.Fatal("中文应判定为含 CJK")
	}
	if !HasCJK("CPU 占用") {
		t.Fatal("中英混排应判定为含 CJK")
	}
	if HasCJK("download") {
		t.Fatal("纯英文不应判定为含 CJK")
	}
	if HasCJK("") {
		t.Fatal("空串不应判定为含 CJK")
	}
}

// 构造浮点指针，供可选字段使用。
func floatPtr(value float64) *float64 { return &value }
