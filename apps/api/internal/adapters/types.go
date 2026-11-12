package adapters

import (
	"context"
	"encoding/json"
)

// Adapter 是一个业务适配器：按类型名登记，按输入拉取并转换指标。
type Adapter interface {
	// Type 返回组件类型名，取值与配置里的类型逐字一致。
	Type() string
	// Run 拉取指标并返回原始结果，由注册表统一规范；实现不得把密钥写入返回值或错误文案。
	Run(ctx context.Context, input RunInput) (any, error)
}

// RunInput 是单次调用的输入，由服务端按当次允许列表映射而来。
type RunInput struct {
	URL     string
	Secrets map[string]string
	Options any
}

// RunRequest 在调用输入之外带上组件类型；类型未登记时不会发起任何出站请求。
type RunRequest struct {
	Type string
	RunInput
}

// 指标状态取值，与前端契约一致。
const (
	MetricStatusOK          = "ok"
	MetricStatusWarn        = "warn"
	MetricStatusError       = "error"
	MetricStatusUnavailable = "unavailable"
)

// Metric 是组件卡片上的一项指标；值只允许字符串或有限数值。
type Metric struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Value  any    `json:"value"`
	Unit   string `json:"unit,omitempty"`
	Status string `json:"status,omitempty"`
}

// SessionSummary 是一条正在播放的会话摘要，进度取值 0–100。
type SessionSummary struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	User     string   `json:"user,omitempty"`
	Episode  string   `json:"episode,omitempty"`
	Progress *float64 `json:"progress,omitempty"`
}

// ServiceWidgetResult 是适配器输出契约：成功带指标（可选会话），失败只带中文原因。
// 结构体不直接带 JSON 标签，序列化形态由成功/失败两条路径分别决定。
type ServiceWidgetResult struct {
	Ok       bool
	Metrics  []Metric
	Sessions []SessionSummary
	Error    string
}

// SuccessResult 构造成功结果，会话为空时不输出该字段。
func SuccessResult(metrics []Metric, sessions []SessionSummary) ServiceWidgetResult {
	return ServiceWidgetResult{Ok: true, Metrics: metrics, Sessions: sessions}
}

// FailureResult 构造失败结果，原因必须是不含密钥的中文文案。
func FailureResult(message string) ServiceWidgetResult {
	if message == "" {
		message = InvalidWidgetResultError
	}
	return ServiceWidgetResult{Ok: false, Error: message}
}

// MarshalJSON 按契约输出两种形态：成功时 metrics 恒为数组，失败时只带 error。
func (r ServiceWidgetResult) MarshalJSON() ([]byte, error) {
	if !r.Ok {
		return json.Marshal(struct {
			Ok    bool   `json:"ok"`
			Error string `json:"error"`
		}{Ok: false, Error: r.Error})
	}

	metrics := r.Metrics
	if metrics == nil {
		metrics = []Metric{}
	}
	var sessions []SessionSummary
	if len(r.Sessions) > 0 {
		sessions = r.Sessions
	}
	return json.Marshal(struct {
		Ok       bool             `json:"ok"`
		Metrics  []Metric         `json:"metrics"`
		Sessions []SessionSummary `json:"sessions,omitempty"`
	}{Ok: true, Metrics: metrics, Sessions: sessions})
}
