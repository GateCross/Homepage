package adapters

import (
	"context"
	"sort"
	"strings"
	"sync"
)

// Registry 是类型到适配器的只读映射，可并发读、注册期独占写。
type Registry struct {
	mu       sync.RWMutex
	adapters map[string]Adapter
}

// NewRegistry 创建空注册表。
func NewRegistry() *Registry {
	return &Registry{adapters: make(map[string]Adapter)}
}

// 进程默认注册表：六个业务适配器装配期各自登记，运行期只读。
var defaultRegistry = NewRegistry()

// Register 在默认注册表登记一个适配器；类型为空或与已登记者冲突时返回错误。
func Register(adapter Adapter) error { return defaultRegistry.Register(adapter) }

// Get 按类型取默认注册表中的适配器。
func Get(widgetType string) (Adapter, bool) { return defaultRegistry.Get(widgetType) }

// Run 在默认注册表上执行一次调用。
func Run(ctx context.Context, request RunRequest) ServiceWidgetResult {
	return defaultRegistry.Run(ctx, request)
}

// Register 登记适配器；同一类型只允许登记一次，空类型与重复登记都返回错误。
func (r *Registry) Register(adapter Adapter) error {
	if adapter == nil {
		return NewError("适配器不能为空")
	}
	widgetType := strings.TrimSpace(adapter.Type())
	if widgetType == "" {
		return NewError("适配器类型不能为空")
	}
	if !isValidWidgetType(widgetType) {
		return NewError("适配器类型不在组件类型范围内")
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.adapters[widgetType]; exists {
		return NewError("适配器类型已登记")
	}
	r.adapters[widgetType] = adapter
	return nil
}

// Get 按类型取适配器；未登记的类型返回 false，调用方不得发起任何出站请求。
func (r *Registry) Get(widgetType string) (Adapter, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	adapter, ok := r.adapters[strings.TrimSpace(widgetType)]
	return adapter, ok
}

// Types 返回已登记的类型，按字典序排列。
func (r *Registry) Types() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	types := make([]string, 0, len(r.adapters))
	for widgetType := range r.adapters {
		types = append(types, widgetType)
	}
	sort.Strings(types)
	return types
}

// Run 执行一次适配器调用并规范输出。
// 未登记的类型直接失败且不发请求；适配器抛错与非法输出都降级为中文失败结果。
func (r *Registry) Run(ctx context.Context, request RunRequest) ServiceWidgetResult {
	adapter, ok := r.Get(request.Type)
	if !ok {
		return FailureResult(UnsupportedWidgetError)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	raw, err := adapter.Run(ctx, request.RunInput)
	if err != nil {
		// 底层错误可能带地址、Cookie 或响应片段，一律只回通用中文原因
		return FailureResult(RequestFailedError)
	}

	result := Validate(raw)
	if !result.Ok && ContainsAnySecret(result.Error, request.Secrets) {
		return FailureResult(RequestFailedError)
	}
	return result
}

// 组件类型取值，与前端列举的六种保持逐字一致。
var widgetTypes = []string{
	"qbittorrent",
	"transmission",
	"emby",
	"customapi",
	"immich",
	"caddy",
}

// 判断类型是否落在契约内的六种取值里。
func isValidWidgetType(widgetType string) bool {
	for _, known := range widgetTypes {
		if known == widgetType {
			return true
		}
	}
	return false
}

// WidgetTypes 返回契约允许的组件类型，按前端列举顺序排列。
func WidgetTypes() []string {
	out := make([]string, len(widgetTypes))
	copy(out, widgetTypes)
	return out
}
