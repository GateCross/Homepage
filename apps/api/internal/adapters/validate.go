package adapters

import (
	"strings"
)

// 失败文案：均不含请求细节，可直接下发给浏览器。
const (
	UnsupportedWidgetError   = "暂不支持该服务组件类型"
	InvalidWidgetResultError = "服务组件返回结果无效"
	RequestFailedError       = "服务组件请求失败"
)

// MaxSessionSummaries 是成功结果里会话摘要的条数上限，与契约一致。
const MaxSessionSummaries = 5

// Validate 把适配器原始结果规范成合法的 ServiceWidgetResult。
// 支持结构体、值指针与 map，字段按 JSON 名匹配；无法识别的形态一律降级为失败结果。
func Validate(raw any) ServiceWidgetResult {
	switch typed := raw.(type) {
	case nil:
		return FailureResult(InvalidWidgetResultError)
	case ServiceWidgetResult:
		return normalizeResult(typed)
	case *ServiceWidgetResult:
		if typed == nil {
			return FailureResult(InvalidWidgetResultError)
		}
		return normalizeResult(*typed)
	case map[string]any:
		return normalizeMapResult(typed)
	}
	return FailureResult(InvalidWidgetResultError)
}

// ValidateMetrics 校验指标列表：标识与标签非空且不重复，标签含中文，值只允许字符串或有限数值。
func ValidateMetrics(metrics []Metric) bool {
	seen := make(map[string]struct{}, len(metrics))
	for _, metric := range metrics {
		if !isMetricWellFormed(metric, seen) {
			return false
		}
		seen[metric.ID] = struct{}{}
	}
	return true
}

// 单项指标是否合法；重复标识由 seen 判定，调用方负责在通过后登记。
func isMetricWellFormed(metric Metric, seen map[string]struct{}) bool {
	if metric.ID == "" {
		return false
	}
	if _, exists := seen[metric.ID]; exists {
		return false
	}
	if metric.Label == "" || !HasCJK(metric.Label) {
		return false
	}
	if metric.Value == nil {
		return false
	}
	switch typed := metric.Value.(type) {
	case string:
	case float64:
		if !isFiniteNumber(typed) {
			return false
		}
	case float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, bool:
	default:
		return false
	}
	if metric.Status != "" && !isValidMetricStatus(metric.Status) {
		return false
	}
	return true
}

// 指标状态只允许契约里的四种取值。
func isValidMetricStatus(status string) bool {
	switch status {
	case MetricStatusOK, MetricStatusWarn, MetricStatusError, MetricStatusUnavailable:
		return true
	}
	return false
}

// 规范结构体形态的结果：成功结果校验指标与会话，失败结果兜底错误文案。
func normalizeResult(result ServiceWidgetResult) ServiceWidgetResult {
	if !result.Ok {
		message := strings.TrimSpace(result.Error)
		if message == "" {
			return FailureResult(InvalidWidgetResultError)
		}
		return FailureResult(message)
	}

	metrics := normalizeMetrics(result.Metrics)
	if !ValidateMetrics(metrics) {
		return FailureResult(InvalidWidgetResultError)
	}
	sessions, ok := normalizeSessions(result.Sessions)
	if !ok {
		return FailureResult(InvalidWidgetResultError)
	}
	return SuccessResult(metrics, sessions)
}

// 把指标整理成可输出形态：字段去空白，布尔值转 1/0 以保持按数值渲染。
func normalizeMetrics(metrics []Metric) []Metric {
	out := make([]Metric, 0, len(metrics))
	for _, metric := range metrics {
		out = append(out, Metric{
			ID:     strings.TrimSpace(metric.ID),
			Label:  strings.TrimSpace(metric.Label),
			Value:  normalizeMetricValue(metric.Value),
			Unit:   strings.TrimSpace(metric.Unit),
			Status: strings.TrimSpace(metric.Status),
		})
	}
	return out
}

// 布尔指标转 1/0，其余取值原样保留。
func normalizeMetricValue(value any) any {
	if flag, ok := value.(bool); ok {
		if flag {
			return 1
		}
		return 0
	}
	return value
}

// 规范会话摘要：超出上限的条目直接丢弃，单条不合法即整体失败。
func normalizeSessions(sessions []SessionSummary) ([]SessionSummary, bool) {
	if len(sessions) == 0 {
		return nil, true
	}
	out := make([]SessionSummary, 0, len(sessions))
	for _, session := range sessions {
		if len(out) == MaxSessionSummaries {
			break
		}
		item, ok := normalizeSession(session)
		if !ok {
			return nil, false
		}
		out = append(out, item)
	}
	return out, true
}

// 单条会话：标识与标题必填，可选字段为空时不输出，进度越界即判失败。
func normalizeSession(session SessionSummary) (SessionSummary, bool) {
	id := strings.TrimSpace(session.ID)
	title := strings.TrimSpace(session.Title)
	if id == "" || title == "" {
		return SessionSummary{}, false
	}
	item := SessionSummary{
		ID:      id,
		Title:   title,
		User:    strings.TrimSpace(session.User),
		Episode: strings.TrimSpace(session.Episode),
	}
	if session.Progress != nil {
		progress := *session.Progress
		if !isFiniteNumber(progress) || progress < 0 || progress > 100 {
			return SessionSummary{}, false
		}
		item.Progress = &progress
	}
	return item, true
}

// 规范 map 形态的结果；字段按契约的 JSON 名取值，缺 ok 或类型不符即失败。
func normalizeMapResult(payload map[string]any) ServiceWidgetResult {
	ok, isBool := payload["ok"].(bool)
	if !isBool {
		return FailureResult(InvalidWidgetResultError)
	}
	if !ok {
		message, _ := payload["error"].(string)
		if strings.TrimSpace(message) == "" {
			return FailureResult(InvalidWidgetResultError)
		}
		return FailureResult(strings.TrimSpace(message))
	}

	rawMetrics, hasMetrics := payload["metrics"]
	if !hasMetrics || rawMetrics == nil {
		return FailureResult(InvalidWidgetResultError)
	}
	metrics, ok := metricsFromAny(rawMetrics)
	if !ok {
		return FailureResult(InvalidWidgetResultError)
	}

	sessions := []SessionSummary(nil)
	if rawSessions, hasSessions := payload["sessions"]; hasSessions && rawSessions != nil {
		parsed, ok := sessionsFromAny(rawSessions)
		if !ok {
			return FailureResult(InvalidWidgetResultError)
		}
		sessions = parsed
	}
	return normalizeResult(SuccessResult(metrics, sessions))
}

// 把松散的指标列表读成结构体；任一元素形态不符即整体失败。
func metricsFromAny(raw any) ([]Metric, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	metrics := make([]Metric, 0, len(items))
	for _, item := range items {
		metric, ok := metricFromAny(item)
		if !ok {
			return nil, false
		}
		metrics = append(metrics, metric)
	}
	return metrics, true
}

// 单条指标按 JSON 名取值；id、label、value 缺一不可。
func metricFromAny(raw any) (Metric, bool) {
	object, ok := raw.(map[string]any)
	if !ok {
		return Metric{}, false
	}
	id, hasID := object["id"].(string)
	label, hasLabel := object["label"].(string)
	if !hasID || !hasLabel {
		return Metric{}, false
	}
	value, hasValue := object["value"]
	if !hasValue || value == nil {
		return Metric{}, false
	}
	metric := Metric{ID: id, Label: label, Value: value}
	if unit, ok := object["unit"].(string); ok {
		metric.Unit = unit
	}
	if status, ok := object["status"].(string); ok {
		metric.Status = status
	}
	return metric, true
}

// 把松散的会话列表读成结构体；任一元素形态不符即整体失败。
func sessionsFromAny(raw any) ([]SessionSummary, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	sessions := make([]SessionSummary, 0, len(items))
	for _, item := range items {
		session, ok := sessionFromAny(item)
		if !ok {
			return nil, false
		}
		sessions = append(sessions, session)
	}
	return sessions, true
}

// 单条会话按 JSON 名取值；id、title 缺一不可，进度必须是有限数值。
func sessionFromAny(raw any) (SessionSummary, bool) {
	object, ok := raw.(map[string]any)
	if !ok {
		return SessionSummary{}, false
	}
	id, hasID := object["id"].(string)
	title, hasTitle := object["title"].(string)
	if !hasID || !hasTitle {
		return SessionSummary{}, false
	}
	session := SessionSummary{ID: id, Title: title}
	if user, ok := object["user"].(string); ok {
		session.User = user
	}
	if episode, ok := object["episode"].(string); ok {
		session.Episode = episode
	}
	if rawProgress, hasProgress := object["progress"]; hasProgress && rawProgress != nil {
		progress, ok := rawProgress.(float64)
		if !ok || !isFiniteNumber(progress) {
			return SessionSummary{}, false
		}
		session.Progress = &progress
	}
	return session, true
}
