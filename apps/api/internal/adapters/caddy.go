package adapters

import (
	"context"
	"math"
	"net/http"
)

// Caddy 的指标标识、字段名与失败文案；文案可直接下发浏览器。
const (
	caddyUpstreamsMetricID      = "upstreams"
	caddyRequestsMetricID       = "requests"
	caddyRequestsFailedMetricID = "requests_failed"

	caddyStatsFail      = "获取 Caddy 上游状态失败"
	caddyStatsTimeout   = "获取 Caddy 上游状态超时"
	caddyStatsNetwork   = "无法连接 Caddy 管理接口"
	caddyStatsBadJSON   = "Caddy 上游响应不是有效 JSON"
	caddyStatsBadFields = "Caddy 上游响应格式无效"
	caddyRequestFail    = "Caddy 请求失败"
)

// 可展示的字段，取值与前端勾选项、结果标识一致；空白名单表示全部展示。
var caddyFieldDefs = []struct {
	id    string
	label string
	field string
}{
	{caddyUpstreamsMetricID, "上游", "upstreams"},
	{caddyRequestsMetricID, "请求", "requests"},
	{caddyRequestsFailedMetricID, "失败", "requests_failed"},
}

// caddyAdapter 读取反向代理上游数量与请求计数，管理接口默认无鉴权。
type caddyAdapter struct{}

// 进程装配期登记到默认注册表，类型名与配置里的类型逐字一致。
func init() { _ = Register(caddyAdapter{}) }

// 组件类型名，取值与配置里的类型逐字一致。
func (caddyAdapter) Type() string { return "caddy" }

// 拉取一次上游列表并转成指标；失败以中文原因返回，响应正文不外带。
func (caddyAdapter) Run(ctx context.Context, input RunInput) (any, error) {
	metrics, err := fetchCaddyUpstreams(ctx, input.URL, parseCaddyOptions(input.Options))
	if err != nil {
		return FailureResult(LocalErrorMessage(err, caddyRequestFail)), nil
	}
	return SuccessResult(metrics, nil), nil
}

// 读取展示字段白名单：只保留字符串，去空白后转小写；形态不符时视为全选。
func parseCaddyOptions(options any) []string {
	doc, ok := options.(map[string]any)
	if !ok {
		return nil
	}
	return FieldList(doc["fields"])
}

// 把上游列表转成指标：非对象条目计入上游总数但跳过计数，空白名单或全被过滤时判为格式无效。
func convertCaddyUpstreams(data any, fields []string) ([]Metric, error) {
	entries, ok := data.([]any)
	if !ok {
		return nil, NewError(caddyStatsBadFields)
	}

	var requests, fails float64
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		requests += NonNegativeFloat(caddyFirstValue(record,
			"num_requests", "numRequests", "requests"))
		fails += NonNegativeFloat(caddyFirstValue(record,
			"fails", "num_fails", "failures"))
	}

	values := map[string]int{
		caddyUpstreamsMetricID:      len(entries),
		caddyRequestsMetricID:       int(math.Trunc(requests)),
		caddyRequestsFailedMetricID: int(math.Trunc(fails)),
	}

	allow := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		allow[field] = struct{}{}
	}

	metrics := make([]Metric, 0, len(caddyFieldDefs))
	for _, def := range caddyFieldDefs {
		if len(allow) > 0 {
			if _, selected := allow[def.field]; !selected {
				continue
			}
		}
		metrics = append(metrics, Metric{
			ID:     def.id,
			Label:  def.label,
			Value:  values[def.field],
			Status: MetricStatusOK,
		})
	}
	if len(metrics) == 0 {
		return nil, NewError(caddyStatsBadFields)
	}
	return metrics, nil
}

// 按键名顺序取首个非空值，模拟逐级回退；全部缺省时返回 nil。
func caddyFirstValue(record map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, exists := record[key]; exists && value != nil {
			return value
		}
	}
	return nil
}

// 请求上游列表；非 2xx 与非法 JSON 都按失败处理，不把响应正文带进文案。
func fetchCaddyUpstreams(ctx context.Context, baseURL string, fields []string) ([]Metric, error) {
	target, err := JoinBaseURL(baseURL, "/reverse_proxy/upstreams")
	if err != nil {
		return nil, err
	}

	payload, err := GetJSON(ctx, target, RequestOptions{
		Method:         http.MethodGet,
		Headers:        map[string]string{"Accept": "application/json"},
		TimeoutMessage: caddyStatsTimeout,
		NetworkMessage: caddyStatsNetwork,
	}, caddyStatsFail, caddyStatsBadJSON)
	if err != nil {
		return nil, err
	}
	return convertCaddyUpstreams(payload, fields)
}
