package adapters

import (
	"context"
	"net/http"
	"strings"
)

// Immich 的指标标识、接口路径与失败文案；文案可直接下发浏览器。
const (
	immichUsersMetricID   = "users"
	immichPhotosMetricID  = "photos"
	immichVideosMetricID  = "videos"
	immichStorageMetricID = "storage"

	// v2 起统计与存储都挂在 /api/server 下；v1 只有统计接口，用量在统计响应里。
	immichStatisticsPathV1 = "/api/server-info/statistics"
	immichStatisticsPathV2 = "/api/server/statistics"
	immichStoragePathV2    = "/api/server/storage"

	immichMissingKey   = "Immich 缺少 API 密钥配置"
	immichStatsFail    = "获取 Immich 统计失败"
	immichStatsTimeout = "获取 Immich 统计超时"
	immichStatsNetwork = "无法连接 Immich 统计接口"
	immichStatsBadJSON = "Immich 统计响应不是有效 JSON"
	immichStatsFields  = "Immich 统计响应缺少有效字段"
	immichRequestFail  = "Immich 请求失败"
)

// 读取用户、照片、视频与存储用量；API 密钥只出现在请求头里。
type immichAdapter struct{}

// 进程装配期登记到默认注册表，类型名与配置里的类型逐字一致。
func init() { _ = Register(immichAdapter{}) }

// 组件类型名，取值与配置里的类型逐字一致。
func (immichAdapter) Type() string { return "immich" }

// 缺少密钥时不发任何请求；业务失败只回中文原因，请求细节与密钥都不外带。
func (immichAdapter) Run(ctx context.Context, input RunInput) (any, error) {
	apiKey, ok := readImmichAPIKey(input.Secrets)
	if !ok {
		return FailureResult(immichMissingKey), nil
	}

	version, fields := parseImmichOptions(input.Options)
	metrics, err := fetchImmichStatistics(ctx, input.URL, apiKey, version, fields)
	if err != nil {
		return FailureResult(LocalErrorMessage(err, immichRequestFail)), nil
	}
	return SuccessResult(metrics, nil), nil
}

// 版本缺省按 2（当前 Immich 的 /api/server 路径）；只有显式写 1 才走旧路径。
func parseImmichOptions(options any) (int, []string) {
	record, ok := options.(map[string]any)
	if !ok {
		return 2, nil
	}
	return immichVersion(record["version"]), immichFieldList(record["fields"])
}

// 展示字段只认非空字符串并统一小写；非字符串项直接丢弃。空列表表示不限字段。
func immichFieldList(value any) []string {
	switch typed := value.(type) {
	case []string:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if field := strings.ToLower(strings.TrimSpace(item)); field != "" {
				out = append(out, field)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				continue
			}
			if field := strings.ToLower(strings.TrimSpace(text)); field != "" {
				out = append(out, field)
			}
		}
		return out
	}
	return nil
}

// 白名单为空表示不限字段，否则只放行列举项。
func immichFieldAllowed(fields []string, name string) bool {
	if len(fields) == 0 {
		return true
	}
	for _, field := range fields {
		if strings.EqualFold(field, name) {
			return true
		}
	}
	return false
}

// 数字、浮点与字符串三种写法都接受，只识别 1，其余按 2 处理。
func immichVersion(value any) int {
	switch typed := value.(type) {
	case float64:
		if typed == 1 {
			return 1
		}
	case int:
		if typed == 1 {
			return 1
		}
	case string:
		if strings.TrimSpace(typed) == "1" {
			return 1
		}
	}
	return 2
}

// 密钥取 key，其次 apiKey、token；去空白后为空即视为未配置。
func readImmichAPIKey(secrets map[string]string) (string, bool) {
	for _, name := range []string{"key", "apiKey", "token"} {
		if value := strings.TrimSpace(secrets[name]); value != "" {
			return value, true
		}
	}
	return "", false
}

// 统计接口失败即整卡失败；统计里没有用量时按版本补拉存储接口，补拉失败只让该项不可用。
func fetchImmichStatistics(ctx context.Context, baseURL, apiKey string, version int, fields []string) ([]Metric, error) {
	statisticsPath := immichStatisticsPathV1
	if version == 2 {
		statisticsPath = immichStatisticsPathV2
	}

	payload, err := immichGet(ctx, baseURL, apiKey, statisticsPath)
	if err != nil {
		return nil, err
	}
	record, ok := payload.(map[string]any)
	if !ok {
		return nil, NewError(immichStatsFields)
	}

	var storageBytes *float64
	// 旧版没有独立存储接口，只认统计响应自带的用量
	if version == 2 && immichFieldAllowed(fields, "storage") && !immichHasStorage(record) {
		if bytes, ok := fetchImmichStorageBytes(ctx, baseURL, apiKey, immichStoragePathV2); ok {
			storageBytes = &bytes
		}
	}
	return convertImmichStatistics(record, fields, storageBytes)
}

// 带 API 密钥取一次 GET；非 2xx 与非法 JSON 都映射成统计接口自己的中文文案。
func immichGet(ctx context.Context, baseURL, apiKey, path string) (any, error) {
	target, err := JoinBaseURL(baseURL, path)
	if err != nil {
		return nil, err
	}

	response, err := Do(ctx, target, RequestOptions{
		Method:         http.MethodGet,
		Headers:        map[string]string{"X-API-Key": apiKey, "Accept": "application/json"},
		TimeoutMessage: immichStatsTimeout,
		NetworkMessage: immichStatsNetwork,
	})
	if err != nil {
		return nil, err
	}
	if !response.OK() {
		return nil, NewError(immichStatsFail)
	}
	return ReadJSONBody(response, immichStatsBadJSON)
}

// 存储用量接口的补充取值：逐块累加数字形式的已用量，取不到即返回 false。
// 该接口版本差异大，任何失败都只降级为该项不可用，不影响其余指标。
func fetchImmichStorageBytes(ctx context.Context, baseURL, apiKey, path string) (float64, bool) {
	payload, err := immichGet(ctx, baseURL, apiKey, path)
	if err != nil {
		return 0, false
	}

	disks, ok := payload.([]any)
	if !ok {
		disks = []any{payload}
	}

	total := 0.0
	found := false
	for _, entry := range disks {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"diskUseRaw", "diskUse", "usage"} {
			if used, ok := immichNonNegNumber(record[key]); ok {
				total += used
				found = true
				break
			}
		}
	}
	return total, found
}

// 统计响应是否自带存储用量，自带时不再请求存储接口。
func immichHasStorage(record map[string]any) bool {
	_, ok := immichReadStorageBytes(record)
	return ok
}

// 指标字段顺序与前端一致：用户、照片、视频、存储。
func convertImmichStatistics(record map[string]any, fields []string, storageBytes *float64) ([]Metric, error) {
	metrics := make([]Metric, 0, 4)
	parsed := 0

	if immichFieldAllowed(fields, "users") {
		if users, ok := immichReadUsers(record); ok {
			parsed++
			metrics = append(metrics, Metric{ID: immichUsersMetricID, Label: "用户", Value: int64(users), Status: MetricStatusOK})
		} else {
			metrics = append(metrics, immichUnavailableMetric(immichUsersMetricID, "用户"))
		}
	}

	// 照片与视频支持多个字段写法，逐个别名尝试
	for _, def := range []struct {
		id    string
		label string
		name  string
		keys  []string
	}{
		{immichPhotosMetricID, "照片", "photos", []string{"photos", "photoCount", "images"}},
		{immichVideosMetricID, "视频", "videos", []string{"videos", "videoCount"}},
	} {
		if !immichFieldAllowed(fields, def.name) {
			continue
		}
		if count, ok := immichReadCount(record, def.keys); ok {
			parsed++
			metrics = append(metrics, Metric{ID: def.id, Label: def.label, Value: int64(count), Status: MetricStatusOK})
		} else {
			metrics = append(metrics, immichUnavailableMetric(def.id, def.label))
		}
	}

	if immichFieldAllowed(fields, "storage") {
		bytes, ok := immichReadStorageBytes(record)
		if !ok && storageBytes != nil {
			bytes, ok = *storageBytes, true
		}
		if ok {
			parsed++
			scaled := ScaleBytes(bytes)
			metrics = append(metrics, Metric{ID: immichStorageMetricID, Label: "存储", Value: scaled.Value, Unit: scaled.Unit, Status: MetricStatusOK})
		} else {
			metrics = append(metrics, immichUnavailableMetric(immichStorageMetricID, "存储"))
		}
	}

	// 全部字段都取不到时不伪造一张空卡片，按无效响应处理
	if len(metrics) == 0 || parsed == 0 {
		return nil, NewError(immichStatsFields)
	}
	return metrics, nil
}

// 取不到值时用破折号占位并标记不可用，不伪造 0。
func immichUnavailableMetric(id, label string) Metric {
	return Metric{ID: id, Label: label, Value: "—", Status: MetricStatusUnavailable}
}

// 用户数优先取 usageByUser 的条目数，其次 users 与 userCount。
func immichReadUsers(record map[string]any) (float64, bool) {
	if byUser, ok := record["usageByUser"].([]any); ok {
		return float64(len(byUser)), true
	}
	return immichReadCount(record, []string{"users", "userCount"})
}

// 按别名顺序取第一个可解析的非负数量。
func immichReadCount(record map[string]any, keys []string) (float64, bool) {
	for _, key := range keys {
		if value, ok := immichNonNegNumber(record[key]); ok {
			return value, true
		}
	}
	return 0, false
}

// 存储用量依次取 usage、usageRaw、storage、diskUsage；都没有时累加 usageByUser 各项的 usage。
func immichReadStorageBytes(record map[string]any) (float64, bool) {
	for _, key := range []string{"usage", "usageRaw", "storage", "diskUsage"} {
		if value, ok := immichNonNegNumber(record[key]); ok {
			return value, true
		}
	}

	byUser, ok := record["usageByUser"].([]any)
	if !ok {
		return 0, false
	}
	total := 0.0
	found := false
	for _, entry := range byUser {
		if item, ok := entry.(map[string]any); ok {
			if usage, ok := immichNonNegNumber(item["usage"]); ok {
				total += usage
				found = true
			}
		}
	}
	return total, found
}

// 数量类字段可以是数字或数字字符串，负值按 0，无法解析时返回 false。
func immichNonNegNumber(value any) (float64, bool) {
	number, ok := CoerceFiniteNumber(value)
	if !ok {
		return 0, false
	}
	if number < 0 {
		return 0, true
	}
	return number, true
}
