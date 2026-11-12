package adapters

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

// fakeAdapter 记录调用次数，并返回测试指定的原始输出与错误。
type fakeAdapter struct {
	widgetType string
	calls      atomic.Int32
	raw        any
	err        error
}

// Type 返回登记用的类型名。
func (f *fakeAdapter) Type() string { return f.widgetType }

// Run 累加调用次数后回放预设结果。
func (f *fakeAdapter) Run(context.Context, RunInput) (any, error) {
	f.calls.Add(1)
	return f.raw, f.err
}

// 构造只含一项合法指标的成功结果。
func okMetrics() []Metric {
	return []Metric{{ID: "download", Label: "下载", Value: 1.5, Unit: "MB/s", Status: MetricStatusOK}}
}

func TestRegistryRejectsUnknownTypeWithoutRequests(t *testing.T) {
	registry := NewRegistry()
	known := &fakeAdapter{widgetType: "emby", raw: SuccessResult(okMetrics(), nil)}
	if err := registry.Register(known); err != nil {
		t.Fatalf("登记失败：%v", err)
	}

	result := registry.Run(context.Background(), RunRequest{Type: "unregistered-type"})
	if result.Ok {
		t.Fatal("未登记类型必须返回失败结果")
	}
	if result.Error != UnsupportedWidgetError {
		t.Fatalf("未登记类型文案应为 %q，实得 %q", UnsupportedWidgetError, result.Error)
	}
	if got := known.calls.Load(); got != 0 {
		t.Fatalf("未登记类型不得触发任何适配器调用，实际 %d 次", got)
	}
}

func TestRegistryRunReturnsSuccess(t *testing.T) {
	registry := NewRegistry()
	adapter := &fakeAdapter{widgetType: "qbittorrent", raw: SuccessResult(okMetrics(), nil)}
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("登记失败：%v", err)
	}

	result := registry.Run(context.Background(), RunRequest{Type: "qbittorrent"})
	if !result.Ok {
		t.Fatalf("应返回成功结果，实得失败：%q", result.Error)
	}
	if len(result.Metrics) != 1 || result.Metrics[0].ID != "download" {
		t.Fatalf("指标不符：%+v", result.Metrics)
	}
	if got := adapter.calls.Load(); got != 1 {
		t.Fatalf("应调用一次，实际 %d 次", got)
	}
}

func TestRegistryDowngradesAdapterError(t *testing.T) {
	registry := NewRegistry()
	adapter := &fakeAdapter{
		widgetType: "immich",
		err:        errors.New("connect failed for http://10.0.0.2:2283 with X-Api-Key: SECRET"),
	}
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("登记失败：%v", err)
	}

	result := registry.Run(context.Background(), RunRequest{
		Type: "immich",
		RunInput: RunInput{
			Secrets: map[string]string{"apiKey": "SECRET"},
		},
	})
	if result.Ok {
		t.Fatal("适配器报错必须降级为失败结果")
	}
	if result.Error != RequestFailedError {
		t.Fatalf("应回通用中文原因，实得 %q", result.Error)
	}
	if ContainsAnySecret(result.Error, map[string]string{"apiKey": "SECRET"}) {
		t.Fatalf("错误结果不得含密钥：%q", result.Error)
	}
}

func TestRegistryDowngradesInvalidOutput(t *testing.T) {
	registry := NewRegistry()
	adapter := &fakeAdapter{widgetType: "caddy", raw: map[string]any{"metrics": "not-a-list"}}
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("登记失败：%v", err)
	}

	result := registry.Run(context.Background(), RunRequest{Type: "caddy"})
	if result.Ok {
		t.Fatal("非法输出必须降级为失败结果")
	}
	if result.Error != InvalidWidgetResultError {
		t.Fatalf("非法输出文案应为 %q，实得 %q", InvalidWidgetResultError, result.Error)
	}
}

func TestRegistryScrubsSecretFromFailureMessage(t *testing.T) {
	registry := NewRegistry()
	// 适配器把密码写进了失败文案，注册表必须在出口拦下
	adapter := &fakeAdapter{
		widgetType: "transmission",
		raw:        FailureResult("登录失败：密码 P@ssw0rd 被拒绝"),
	}
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("登记失败：%v", err)
	}

	result := registry.Run(context.Background(), RunRequest{
		Type: "transmission",
		RunInput: RunInput{
			Secrets: map[string]string{"password": "P@ssw0rd"},
		},
	})
	if result.Ok {
		t.Fatal("失败文案含密钥时应整体降级")
	}
	if ContainsAnySecret(result.Error, map[string]string{"password": "P@ssw0rd"}) {
		t.Fatalf("错误结果不得含密钥：%q", result.Error)
	}
	if result.Error != RequestFailedError {
		t.Fatalf("应回通用中文原因，实得 %q", result.Error)
	}
}

func TestRegistryRejectsDuplicateRegistration(t *testing.T) {
	registry := NewRegistry()
	first := &fakeAdapter{widgetType: "emby"}
	if err := registry.Register(first); err != nil {
		t.Fatalf("首次登记应成功：%v", err)
	}

	second := &fakeAdapter{widgetType: "emby"}
	if err := registry.Register(second); err == nil {
		t.Fatal("重复登记同一类型必须失败")
	}

	adapter, ok := registry.Get("emby")
	if !ok || adapter != first {
		t.Fatal("重复登记不应覆盖先登记者")
	}
}

func TestRegistryRejectsInvalidTypeAndNil(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(nil); err == nil {
		t.Fatal("空适配器必须被拒绝")
	}
	if err := registry.Register(&fakeAdapter{widgetType: "  "}); err == nil {
		t.Fatal("空类型必须被拒绝")
	}
	if err := registry.Register(&fakeAdapter{widgetType: "prometheus"}); err == nil {
		t.Fatal("契约外的类型必须被拒绝")
	}
}

func TestRegistryTypesAreSorted(t *testing.T) {
	registry := NewRegistry()
	for _, widgetType := range []string{"immich", "caddy", "emby"} {
		if err := registry.Register(&fakeAdapter{widgetType: widgetType}); err != nil {
			t.Fatalf("登记 %q 失败：%v", widgetType, err)
		}
	}

	types := registry.Types()
	want := []string{"caddy", "emby", "immich"}
	if len(types) != len(want) {
		t.Fatalf("类型数量不符：%v", types)
	}
	for index, expected := range want {
		if types[index] != expected {
			t.Fatalf("类型应按字典序，实得 %v", types)
		}
	}
}

func TestRegistryGetTrimsType(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(&fakeAdapter{widgetType: "caddy"}); err != nil {
		t.Fatalf("登记失败：%v", err)
	}
	if _, ok := registry.Get(" caddy "); !ok {
		t.Fatal("查询应忽略首尾空白")
	}
}

func TestWidgetTypesCoverContract(t *testing.T) {
	types := WidgetTypes()
	if len(types) != 6 {
		t.Fatalf("契约共六种组件类型，实得 %d：%v", len(types), types)
	}
	for _, widgetType := range types {
		if !isValidWidgetType(widgetType) {
			t.Fatalf("%q 应在契约类型范围内", widgetType)
		}
	}
}
