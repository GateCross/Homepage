package adapters

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode"
)

// Custom API 的取值格式白名单，取值与前端勾选项逐字一致。
var customAPIFormats = []string{"number", "percent", "bytes", "duration", "text"}

// 路径段禁止出现的原型链键，大小写不敏感匹配。
var customAPIForbiddenSegments = []string{"__proto__", "prototype", "constructor"}

// 路径中禁止出现的表达式痕迹字符。
const customAPIForbiddenPathChars = "()[]{}\"'`+-*/%=<>!&|?:;\\"

// Custom API 的失败文案与占位符；文案可直接下发浏览器。
const (
	customAPIRequestFail       = "Custom API 请求失败"
	customAPIRequestTimeout    = "Custom API 请求超时"
	customAPIRequestNetwork    = "无法连接 Custom API"
	customAPIRequestBadJSON    = "Custom API 返回了无效的 JSON"
	customAPIMethodUnsupported = "Custom API 仅支持 GET 方法"
	customAPIUnavailableText   = "不可用"
)

// 一次调用的选项：方法、请求头与取值映射；请求体不可配置。
type customAPIOptions struct {
	method   string
	headers  map[string]string
	mappings []any
}

// 单条取值映射；字段缺失时按空值处理，标识与标签由响应映射阶段补默认值。
type customAPIMapping struct {
	id     string
	label  string
	field  string
	path   string
	format string
}

// 单条映射的格式化结果；unit 为空表示不输出，status 为空表示不带状态。
type customAPIFormatted struct {
	value  any
	unit   string
	status string
}

// customApiAdapter 按配置的取值映射从任意 JSON 接口抽取指标。
type customApiAdapter struct{}

// 进程装配期登记到默认注册表，类型名与配置里的类型逐字一致。
func init() { _ = Register(customApiAdapter{}) }

// 组件类型名，取值与配置里的类型逐字一致。
func (customApiAdapter) Type() string { return "customapi" }

// 按选项拉取一次并映射成指标；选项非法时只回中文原因，不发请求。
func (customApiAdapter) Run(ctx context.Context, input RunInput) (any, error) {
	options, err := parseCustomAPIOptions(input.Options)
	if err != nil {
		return FailureResult(LocalErrorMessage(err, customAPIRequestFail)), nil
	}

	metrics, err := fetchCustomAPIMetrics(ctx, input.URL, options)
	if err != nil {
		return FailureResult(LocalErrorMessage(err, customAPIRequestFail)), nil
	}
	return SuccessResult(metrics, nil), nil
}

// 解析选项：方法缺省为 GET，headers 与 mappings 形态不符即返回中文错误。
func parseCustomAPIOptions(options any) (customAPIOptions, error) {
	parsed := customAPIOptions{method: http.MethodGet}
	if options == nil {
		return parsed, nil
	}
	doc, ok := options.(map[string]any)
	if !ok {
		return customAPIOptions{}, NewError("Custom API 的 options 必须为对象")
	}

	if raw, exists := doc["method"]; exists && raw != nil {
		method, ok := raw.(string)
		if !ok {
			return customAPIOptions{}, NewError("Custom API 的 method 必须为字符串")
		}
		method = strings.TrimSpace(method)
		if method != "" {
			parsed.method = strings.ToUpper(method)
		}
	}

	headers, err := parseCustomAPIHeaders(doc["headers"])
	if err != nil {
		return customAPIOptions{}, err
	}
	parsed.headers = headers

	mappings, err := parseCustomAPIMappings(doc["mappings"])
	if err != nil {
		return customAPIOptions{}, err
	}
	parsed.mappings = mappings
	return parsed, nil
}

// 请求头只接受对象且值必须是字符串，空名请求头跳过；缺省时返回空表。
func parseCustomAPIHeaders(raw any) (map[string]string, error) {
	if raw == nil {
		return map[string]string{}, nil
	}
	doc, ok := raw.(map[string]any)
	if !ok {
		return nil, NewError("Custom API 的 headers 必须为对象")
	}

	headers := make(map[string]string, len(doc))
	for name, value := range doc {
		headerName := strings.TrimSpace(name)
		if headerName == "" {
			continue
		}
		text, ok := value.(string)
		if !ok {
			return nil, NewError("Custom API 请求头 " + headerName + " 的值必须为字符串")
		}
		headers[headerName] = text
	}
	return headers, nil
}

// 映射列表只接受数组；条目形态交给响应映射阶段逐条隔离，非法项跳过而非整卡失败。
// 兼容两种来源：配置加载放的是 []map[string]any，JSON 解码得到的是 []any。
func parseCustomAPIMappings(raw any) ([]any, error) {
	if raw == nil {
		return nil, nil
	}
	switch list := raw.(type) {
	case []any:
		return list, nil
	case []map[string]any:
		out := make([]any, len(list))
		for i, entry := range list {
			out[i] = entry
		}
		return out, nil
	default:
		return nil, NewError("Custom API 的 mappings 必须为数组")
	}
}

// 单条映射只保留字符串字段，其余类型直接丢弃。
func normalizeCustomAPIMapping(raw any) (customAPIMapping, bool) {
	object, ok := raw.(map[string]any)
	if !ok {
		return customAPIMapping{}, false
	}
	var mapping customAPIMapping
	if text, ok := object["id"].(string); ok {
		mapping.id = text
	}
	if text, ok := object["label"].(string); ok {
		mapping.label = text
	}
	if text, ok := object["field"].(string); ok {
		mapping.field = text
	}
	if text, ok := object["path"].(string); ok {
		mapping.path = text
	}
	if text, ok := object["format"].(string); ok {
		mapping.format = text
	}
	return mapping, true
}

// 取值路径优先用 field，其次用 path；两者都为空时返回空串。
func resolveCustomAPIPath(mapping customAPIMapping) string {
	if trimmed := strings.TrimSpace(mapping.field); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(mapping.path)
}

// 校验并拆分点路径：拒绝表达式字符、空白、原型链键与非规范下标，非法时返回 false。
func parseCustomAPIDotPath(raw string) ([]string, bool) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return nil, false
	}
	if strings.ContainsAny(path, customAPIForbiddenPathChars) {
		return nil, false
	}
	if strings.ContainsFunc(path, unicode.IsSpace) {
		return nil, false
	}

	segments := strings.Split(path, ".")
	for _, segment := range segments {
		if segment == "" {
			return nil, false
		}
		lowered := strings.ToLower(segment)
		for _, forbidden := range customAPIForbiddenSegments {
			if lowered == forbidden {
				return nil, false
			}
		}
		if isCustomAPIDigits(segment) {
			// 数组下标只接受规范写法，前导零（如 01）判为非法
			if len(segment) > 1 && strings.HasPrefix(segment, "0") {
				return nil, false
			}
			continue
		}
		if !isCustomAPIKeySegment(segment) {
			return nil, false
		}
	}
	return segments, true
}

// 判断是否只由 ASCII 数字组成。
func isCustomAPIDigits(segment string) bool {
	for _, char := range segment {
		if char < '0' || char > '9' {
			return false
		}
	}
	return segment != ""
}

// 判断单段键名：首字符为字母或下划线，其后允许字母与数字；连字符属于表达式字符，已在前置过滤中拒绝。
func isCustomAPIKeySegment(segment string) bool {
	for index, char := range segment {
		if index == 0 {
			if !isCustomAPIKeyStart(char) {
				return false
			}
			continue
		}
		if !isCustomAPIKeyStart(char) && !(char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}

// 键名首字符：下划线或任意 Unicode 字母。
func isCustomAPIKeyStart(char rune) bool {
	return char == '_' || unicode.IsLetter(char)
}

// 按路径逐层取值；路径非法、键不存在、下标越界或类型不符都返回 false。
func getCustomAPIValue(root any, path string) (any, bool) {
	segments, ok := parseCustomAPIDotPath(path)
	if !ok {
		return nil, false
	}

	current := root
	for _, segment := range segments {
		if current == nil {
			return nil, false
		}
		if isCustomAPIDigits(segment) {
			items, ok := current.([]any)
			if !ok {
				return nil, false
			}
			index, err := strconv.Atoi(segment)
			if err != nil || index >= len(items) {
				return nil, false
			}
			current = items[index]
			continue
		}
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		value, exists := object[segment]
		if !exists {
			return nil, false
		}
		current = value
	}
	return current, true
}

// 按格式把原始值转成展示值；格式未知或取值无法转换时返回 false，由调用方降级。
func formatCustomAPIValue(raw any, format string) (customAPIFormatted, bool) {
	name := strings.ToLower(strings.TrimSpace(format))
	if name == "" {
		name = "text"
	}
	if !isCustomAPIFormat(name) {
		return customAPIFormatted{value: customAPIUnavailableText, status: MetricStatusUnavailable}, true
	}

	switch name {
	case "number":
		number, ok := CoerceFiniteNumber(raw)
		if !ok {
			return customAPIFormatted{}, false
		}
		return customAPIFormatted{value: number, status: MetricStatusOK}, true
	case "percent":
		percent, ok := FormatPercentValue(raw)
		if !ok {
			return customAPIFormatted{}, false
		}
		return customAPIFormatted{value: percent, unit: "%", status: MetricStatusOK}, true
	case "bytes":
		number, ok := CoerceFiniteNumber(raw)
		if !ok {
			return customAPIFormatted{}, false
		}
		scaled := ScaleBytes(number)
		return customAPIFormatted{value: scaled.Value, unit: scaled.Unit, status: MetricStatusOK}, true
	case "duration":
		number, ok := CoerceFiniteNumber(raw)
		if !ok {
			return customAPIFormatted{}, false
		}
		return customAPIFormatted{value: FormatDurationSeconds(number), status: MetricStatusOK}, true
	default: // text
		if text, ok := raw.(string); ok {
			return customAPIFormatted{value: text, status: MetricStatusOK}, true
		}
		if flag, ok := raw.(bool); ok {
			return customAPIFormatted{value: strconv.FormatBool(flag), status: MetricStatusOK}, true
		}
		// 数字统一按十进制文本输出，整数不带小数尾巴
		if number, ok := CoerceFiniteNumber(raw); ok {
			return customAPIFormatted{
				value:  strconv.FormatFloat(number, 'f', -1, 64),
				status: MetricStatusOK,
			}, true
		}
		// 对象与数组不序列化，避免意外体积，按单条失败隔离
		return customAPIFormatted{}, false
	}
}

// 判断格式是否在白名单内。
func isCustomAPIFormat(name string) bool {
	for _, known := range customAPIFormats {
		if known == name {
			return true
		}
	}
	return false
}

// 单条映射不可用的统一形态：占位文本加不可用状态，不伪造 0。
func customAPIUnavailableMetric(id, label string) Metric {
	return Metric{
		ID:     id,
		Label:  label,
		Value:  customAPIUnavailableText,
		Status: MetricStatusUnavailable,
	}
}

// 逐条映射响应：单条失败只让该项不可用，标签缺中文时补前缀，标识重复时加下标。
func mapCustomAPIResponse(data any, mappings []any) []Metric {
	metrics := make([]Metric, 0, len(mappings))
	seenIDs := make(map[string]struct{}, len(mappings))

	for index, rawMapping := range mappings {
		mapping, ok := normalizeCustomAPIMapping(rawMapping)
		if !ok {
			continue
		}

		label := customAPILabel(mapping.label, index)
		id := customAPIMetricID(mapping.id, index, seenIDs)
		seenIDs[id] = struct{}{}

		metric, ok := customAPIMetric(data, mapping, id, label)
		if !ok {
			metrics = append(metrics, customAPIUnavailableMetric(id, label))
			continue
		}
		metrics = append(metrics, metric)
	}
	return metrics
}

// 标签缺省为「指标N」，不含中文时补「指标 」前缀以满足结果校验。
func customAPILabel(raw string, index int) string {
	label := strings.TrimSpace(raw)
	if label == "" {
		label = "指标" + strconv.Itoa(index+1)
	}
	if HasCJK(label) {
		return label
	}
	return "指标 " + label
}

// 标识缺省为 mapping_下标，重复时追加下标以保持唯一。
func customAPIMetricID(raw string, index int, seen map[string]struct{}) string {
	id := strings.TrimSpace(raw)
	if id == "" {
		id = "mapping_" + strconv.Itoa(index)
	}
	if _, exists := seen[id]; exists {
		id = id + "_" + strconv.Itoa(index)
	}
	return id
}

// 单条映射的取值与格式化；路径非法、取值缺失或转换失败都返回 false。
func customAPIMetric(data any, mapping customAPIMapping, id, label string) (Metric, bool) {
	path := resolveCustomAPIPath(mapping)
	if path == "" {
		return Metric{}, false
	}
	rawValue, ok := getCustomAPIValue(data, path)
	if !ok || rawValue == nil {
		return Metric{}, false
	}

	formatted, ok := formatCustomAPIValue(rawValue, mapping.format)
	if !ok {
		return Metric{}, false
	}
	metric := Metric{
		ID:     id,
		Label:  label,
		Value:  formatted.value,
		Unit:   formatted.unit,
		Status: formatted.status,
	}
	return metric, true
}

// 请求接口并映射指标；只允许 GET，非 2xx 与非法 JSON 都按失败处理。
func fetchCustomAPIMetrics(ctx context.Context, rawURL string, options customAPIOptions) ([]Metric, error) {
	method := strings.TrimSpace(options.method)
	if method == "" {
		method = http.MethodGet
	}
	if !strings.EqualFold(method, http.MethodGet) {
		return nil, NewError(customAPIMethodUnsupported)
	}

	headers := map[string]string{"Accept": "application/json"}
	for name, value := range options.headers {
		headers[name] = value
	}

	payload, err := GetJSON(ctx, rawURL, RequestOptions{
		Method:         http.MethodGet,
		Headers:        headers,
		TimeoutMessage: customAPIRequestTimeout,
		NetworkMessage: customAPIRequestNetwork,
	}, customAPIRequestFail, customAPIRequestBadJSON)
	if err != nil {
		return nil, err
	}
	return mapCustomAPIResponse(payload, options.mappings), nil
}
