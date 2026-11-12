package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// 天气请求的固定参数，取值与 TS 实现逐字一致。
const (
	// XiaomiWeatherBaseURL 是小米天气聚合接口，按中国天气网城市编码取数。
	XiaomiWeatherBaseURL = "https://weatherapi.market.xiaomi.com/wtr-v3/weather/all"
	// XiaomiWeatherAppKey 与 XiaomiWeatherSign 是接口要求的两项鉴权参数。
	XiaomiWeatherAppKey = "weather20151024"
	XiaomiWeatherSign   = "zUFJoAR2ZVrDy1vF3D07"
	// XiaomiWeatherTimeout 是单次天气请求的超时。
	XiaomiWeatherTimeout = 10 * time.Second
	// XiaomiForecastDays 是向小米侧请求的预报天数，接口上限约 15 天。
	XiaomiForecastDays = 7
	// HourlyForecastLimit 与 DailyForecastLimit 是下发给前端的点数上限。
	HourlyForecastLimit = 24
	DailyForecastLimit  = 7
	// weatherMaxResponseBytes 是天气响应体上限，超出即断开。
	weatherMaxResponseBytes = 4 << 20
	// locationKeyPrefix 是城市编码必须携带的前缀，裸编码会被拒绝。
	locationKeyPrefix = "weathercn:"
)

// 「已过去的时点」容忍到当前整点后半小时，避免整点刚过就丢掉当前这一段。
const hourlyPastTolerance = 30 * time.Minute

// 天气服务的失败来源，消息可直接外传给前端。
var (
	// ErrWeatherUnavailable 表示连不上或返回了非 2xx。
	ErrWeatherUnavailable = errors.New("无法获取天气信息")
	// ErrWeatherTimeout 表示请求在超时内没有完成。
	ErrWeatherTimeout = errors.New("获取天气信息超时")
	// ErrWeatherInvalid 表示响应不是可解析的 JSON 或结构不符合预期。
	ErrWeatherInvalid = errors.New("天气数据转换失败")
)

// OpenMeteoTarget 是天气目标：城市编码只允许纯数字，地点名只看展示。
type OpenMeteoTarget struct {
	CityID   string
	Location string
}

// WeatherHourlyItem 是逐小时预报点，时间保留服务端给的偏移。
type WeatherHourlyItem struct {
	Time          string  `json:"time"`
	TemperatureC  float64 `json:"temperatureC"`
	WeatherCode   *int    `json:"weatherCode,omitempty"`
	ConditionText *string `json:"conditionText,omitempty"`
}

// WeatherDailyItem 是逐日预报点，日期为当地日历日。
type WeatherDailyItem struct {
	Date            string  `json:"date"`
	TemperatureMaxC float64 `json:"temperatureMaxC"`
	TemperatureMinC float64 `json:"temperatureMinC"`
	WeatherCode     *int    `json:"weatherCode,omitempty"`
	ConditionText   *string `json:"conditionText,omitempty"`
}

// OpenMeteoInfoResponse 与前端契约同名，字段名逐字一致。
// 除 temperatureC 外都可缺省，缺数据时整字段不出现，不用 0 或美标值填充。
type OpenMeteoInfoResponse struct {
	TemperatureC     float64             `json:"temperatureC"`
	ConditionText    *string             `json:"conditionText,omitempty"`
	WeatherCode      *int                `json:"weatherCode,omitempty"`
	Location         *string             `json:"location,omitempty"`
	HumidityPercent  *float64            `json:"humidityPercent,omitempty"`
	Aqi              *float64            `json:"aqi,omitempty"`
	FeelsLikeC       *float64            `json:"feelsLikeC,omitempty"`
	WindSpeedKmh     *float64            `json:"windSpeedKmh,omitempty"`
	WindDirectionDeg *float64            `json:"windDirectionDeg,omitempty"`
	UVIndex          *float64            `json:"uvIndex,omitempty"`
	PressureHpa      *float64            `json:"pressureHpa,omitempty"`
	Sunrise          *string             `json:"sunrise,omitempty"`
	Sunset           *string             `json:"sunset,omitempty"`
	Hourly           []WeatherHourlyItem `json:"hourly,omitempty"`
	Daily            []WeatherDailyItem  `json:"daily,omitempty"`
}

// WeatherClientOptions 覆盖默认超时、基础地址与底层 HTTP 客户端，测试可注入。
type WeatherClientOptions struct {
	Timeout time.Duration
	BaseURL string
	HTTP    *http.Client
	Now     func() time.Time
}

// WeatherClient 负责拉取并转换天气数据，可并发复用。
type WeatherClient struct {
	baseURL string
	timeout time.Duration
	http    *http.Client
	now     func() time.Time
}

// NewWeatherClient 构造天气客户端；超时与地址缺省时取包内常量。
func NewWeatherClient(options WeatherClientOptions) *WeatherClient {
	baseURL := strings.TrimSpace(options.BaseURL)
	if baseURL == "" {
		baseURL = XiaomiWeatherBaseURL
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = XiaomiWeatherTimeout
	}
	client := options.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &WeatherClient{baseURL: baseURL, timeout: timeout, http: client, now: now}
}

// Fetch 拉取指定城市的当前天气、空气质量、逐小时与逐日预报。
// 只有温度缺失或响应结构异常才返回错误，其余字段单项缺失只会从结果里消失。
func (c *WeatherClient) Fetch(ctx context.Context, target OpenMeteoTarget) (OpenMeteoInfoResponse, error) {
	requestURL, ok := buildWeatherURL(c.baseURL, target.CityID)
	if !ok {
		return OpenMeteoInfoResponse{}, ErrWeatherInvalid
	}

	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return OpenMeteoInfoResponse{}, ErrWeatherInvalid
	}
	request.Header.Set("Accept", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		if isTimeoutErr(err) {
			return OpenMeteoInfoResponse{}, ErrWeatherTimeout
		}
		return OpenMeteoInfoResponse{}, ErrWeatherUnavailable
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode < 200 || response.StatusCode > 299 {
		return OpenMeteoInfoResponse{}, ErrWeatherUnavailable
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, weatherMaxResponseBytes+1))
	if err != nil {
		return OpenMeteoInfoResponse{}, ErrWeatherUnavailable
	}
	if len(body) > weatherMaxResponseBytes {
		return OpenMeteoInfoResponse{}, ErrWeatherInvalid
	}

	payload, err := decodeJSONObject(body)
	if err != nil {
		return OpenMeteoInfoResponse{}, ErrWeatherInvalid
	}
	return convertWeatherPayload(payload, target.Location, c.now())
}

// 拼请求地址；城市编码必须是 6–12 位纯数字，其余一律拒绝，避免拼出任意 locationKey。
func buildWeatherURL(baseURL, cityID string) (string, bool) {
	if !validCityID(cityID) {
		return "", false
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	query := parsed.Query()
	query.Set("latitude", "0")
	query.Set("longitude", "0")
	query.Set("locationKey", locationKeyPrefix+cityID)
	query.Set("days", strconv.Itoa(XiaomiForecastDays))
	query.Set("appKey", XiaomiWeatherAppKey)
	query.Set("sign", XiaomiWeatherSign)
	query.Set("isGlobal", "false")
	query.Set("locale", "zh_cn")
	parsed.RawQuery = query.Encode()
	return parsed.String(), true
}

// 城市编码为 6–12 位纯数字。
func validCityID(cityID string) bool {
	if len(cityID) < 6 || len(cityID) > 12 {
		return false
	}
	for _, r := range cityID {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// 把顶层 JSON 解成通用结构；数字保留原文，避免浮点精度与整数类型丢失。
// 数组与标量都不是预期的天气响应。
func decodeJSONObject(body []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return nil, err
	}
	root, ok := payload.(map[string]any)
	if !ok {
		return nil, ErrWeatherInvalid
	}
	return root, nil
}

// 把小米天气响应转换成契约结构；缺少当前温度即视为整体失败。
func convertWeatherPayload(root map[string]any, location string, now time.Time) (OpenMeteoInfoResponse, error) {
	current, ok := asObject(root["current"])
	if !ok {
		return OpenMeteoInfoResponse{}, ErrWeatherInvalid
	}
	temperature, ok := readUnitValue(current["temperature"])
	if !ok {
		return OpenMeteoInfoResponse{}, ErrWeatherInvalid
	}

	forecastDaily, _ := asObject(root["forecastDaily"])

	info := OpenMeteoInfoResponse{TemperatureC: temperature}
	if city := strings.TrimSpace(location); city != "" {
		info.Location = &city
	}

	if code, ok := readWeatherCode(current["weather"]); ok {
		info.WeatherCode = &code
		text := ConditionText(code)
		info.ConditionText = &text
	} else {
		// 契约要求天气码与描述至少给一个，两者都缺时补未知描述
		text := unknownConditionText
		info.ConditionText = &text
	}

	if humidity, ok := parseHumidityPercent(current["humidity"]); ok {
		info.HumidityPercent = &humidity
	}
	if feelsLike, ok := parseFeelsLike(current["feelsLike"]); ok {
		info.FeelsLikeC = &feelsLike
	}
	if windSpeed, ok := parseWindSpeed(current["wind"]); ok {
		info.WindSpeedKmh = &windSpeed
	}
	if direction, ok := parseWindDirection(current["wind"]); ok {
		info.WindDirectionDeg = &direction
	}
	if uv, ok := parseUVIndex(current["uvIndex"]); ok {
		info.UVIndex = &uv
	}
	if pressure, ok := parsePressureHpa(current["pressure"]); ok {
		info.PressureHpa = &pressure
	}
	// 国标口径无法确认时不写该字段，绝不用美标数值兜底
	if aqi, ok := parseChinaAqi(root["aqi"]); ok {
		info.Aqi = &aqi
	}
	if sun := parseTodaySunTimes(forecastDaily); sun != nil {
		info.Sunrise = sun.sunrise
		info.Sunset = sun.sunset
	}
	if hourly := parseHourlyForecast(root["forecastHourly"], now); len(hourly) > 0 {
		info.Hourly = hourly
	}
	if daily := parseDailyForecast(forecastDaily); len(daily) > 0 {
		info.Daily = daily
	}
	return info, nil
}

// 取对象子节点；数组与标量都不是预期结构。
func asObject(node any) (map[string]any, bool) {
	value, ok := node.(map[string]any)
	return value, ok
}

// 取数组子节点。
func asArray(node any) ([]any, bool) {
	value, ok := node.([]any)
	return value, ok
}

// 温度类字段既可能是数字，也可能是带 value 的对象或数字字符串；非法值返回 false。
func readUnitValue(node any) (float64, bool) {
	switch value := node.(type) {
	case float64:
		return finiteOrDrop(value)
	case json.Number:
		return parseNumberText(value.String())
	case string:
		return parseNumberText(value)
	case map[string]any:
		return readUnitValue(value["value"])
	}
	return 0, false
}

// 字符串形态的数字按 64 位浮点解析，非有限值丢弃。
func parseNumberText(raw string) (float64, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return finiteOrDrop(parsed)
}

// NaN 与无穷不是可用数值。
func finiteOrDrop(value float64) (float64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// 状况码只取整数部分；非数字返回 false。
func readWeatherCode(node any) (int, bool) {
	value, ok := readUnitValue(node)
	if !ok {
		return 0, false
	}
	return int(math.Trunc(value)), true
}

// 日预报的状况码可能是 from/to 结构，白天取 from，缺失再退到 to。
func readDayWeatherCode(node any) (int, bool) {
	object, ok := asObject(node)
	if !ok {
		return readWeatherCode(node)
	}
	if code, ok := readWeatherCode(object["from"]); ok {
		return code, true
	}
	return readWeatherCode(object["to"])
}

// 相对湿度只接受 0–100。
func parseHumidityPercent(node any) (float64, bool) {
	value, ok := readUnitValue(node)
	if !ok || value < 0 || value > 100 {
		return 0, false
	}
	return value, true
}

// 体感温度只接受 -90–70 ℃。
func parseFeelsLike(node any) (float64, bool) {
	value, ok := readUnitValue(node)
	if !ok || value < -90 || value > 70 {
		return 0, false
	}
	return value, true
}

// 风速单位 km/h，只接受 0–400。
func parseWindSpeed(node any) (float64, bool) {
	object, ok := asObject(node)
	if !ok {
		return 0, false
	}
	value, ok := readUnitValue(object["speed"])
	if !ok || value < 0 || value > 400 {
		return 0, false
	}
	return value, true
}

// 风向为气象来向，只接受 0–360 度。
func parseWindDirection(node any) (float64, bool) {
	object, ok := asObject(node)
	if !ok {
		return 0, false
	}
	value, ok := readUnitValue(object["direction"])
	if !ok || value < 0 || value > 360 {
		return 0, false
	}
	return value, true
}

// 紫外线指数只接受 0–20。
func parseUVIndex(node any) (float64, bool) {
	value, ok := readUnitValue(node)
	if !ok || value < 0 || value > 20 {
		return 0, false
	}
	return value, true
}

// 气压单位为 hPa，只接受 800–1100 的海平面合理区间。
func parsePressureHpa(node any) (float64, bool) {
	value, ok := readUnitValue(node)
	if !ok || value < 800 || value > 1100 {
		return 0, false
	}
	return value, true
}

// 中国国标 AQI（HJ633）：只认根级 aqi.aqi 的整数或数字字符串，范围 0–500。
// 带 value 的对象与其它口径（如美标）无法确认为国标，一律不取，让字段整体消失。
func parseChinaAqi(node any) (float64, bool) {
	object, ok := asObject(node)
	if !ok {
		return 0, false
	}
	var value float64
	switch raw := object["aqi"].(type) {
	case float64:
		value = raw
	case json.Number:
		parsed, err := strconv.ParseFloat(raw.String(), 64)
		if err != nil {
			return 0, false
		}
		value = parsed
	case string:
		parsed, ok := parseNumberText(raw)
		if !ok {
			return 0, false
		}
		value = parsed
	default:
		return 0, false
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 500 {
		return 0, false
	}
	return math.Round(value), true
}

// 日出日落：取逐日预报第一条的 from/to，值必须可解析为 ISO 时间。
type sunTimes struct {
	sunrise *string
	sunset  *string
}

// 从 forecastDaily.sunRiseSet 取今日日出与日落，缺失时返回 nil。
func parseTodaySunTimes(forecastDaily map[string]any) *sunTimes {
	sunNode, ok := asObject(forecastDaily["sunRiseSet"])
	if !ok {
		return nil
	}
	values, ok := asArray(sunNode["value"])
	if !ok || len(values) == 0 {
		return nil
	}
	first, ok := asObject(values[0])
	if !ok {
		return nil
	}
	sun := &sunTimes{}
	if sunrise, ok := normalizeISOText(first["from"]); ok {
		sun.sunrise = &sunrise
	}
	if sunset, ok := normalizeISOText(first["to"]); ok {
		sun.sunset = &sunset
	}
	if sun.sunrise == nil && sun.sunset == nil {
		return nil
	}
	return sun
}

// 逐小时预报：温度与状况码为平行数组，时间轴优先取 wind.value[].datetime，
// 否则以温度发布时间为起点按小时递推；已过去超过半小时的时点丢弃。
func parseHourlyForecast(node any, now time.Time) []WeatherHourlyItem {
	forecast, ok := asObject(node)
	if !ok {
		return nil
	}
	temperatureNode, _ := asObject(forecast["temperature"])
	weatherNode, _ := asObject(forecast["weather"])
	windNode, _ := asObject(forecast["wind"])

	temperatures, ok := asArray(temperatureNode["value"])
	if !ok || len(temperatures) == 0 {
		return nil
	}
	var codes []any
	if weatherNode != nil {
		codes, _ = asArray(weatherNode["value"])
	}
	var windValues []any
	if windNode != nil {
		windValues, _ = asArray(windNode["value"])
	}

	startLine, ok := hourlyStartLine(windValues, temperatureNode, weatherNode)
	if !ok {
		return nil
	}

	items := make([]WeatherHourlyItem, 0, HourlyForecastLimit)
	for index := range temperatures {
		temperature, ok := readUnitValue(temperatures[index])
		if !ok {
			continue
		}

		timeText, point, ok := hourlyTimeAt(windValues, index, startLine)
		if !ok {
			continue
		}
		if point.Before(now.Add(-hourlyPastTolerance)) {
			continue
		}

		item := WeatherHourlyItem{Time: timeText, TemperatureC: temperature}
		if index < len(codes) {
			if code, ok := readWeatherCode(codes[index]); ok {
				text := ConditionText(code)
				item.WeatherCode = &code
				item.ConditionText = &text
			}
		}
		items = append(items, item)
		if len(items) >= HourlyForecastLimit {
			break
		}
	}
	if len(items) == 0 {
		return nil
	}
	return items
}

// 时间轴起点：优先第一条风的 datetime，其次温度的发布时间，再次状况码发布时间。
func hourlyStartLine(windValues []any, temperatureNode, weatherNode map[string]any) (time.Time, bool) {
	if len(windValues) > 0 {
		if first, ok := asObject(windValues[0]); ok {
			if text, ok := normalizeISOText(first["datetime"]); ok {
				if parsed, err := time.Parse(time.RFC3339, text); err == nil {
					return parsed, true
				}
			}
		}
	}
	if temperatureNode != nil {
		if text, ok := normalizeISOText(temperatureNode["pubTime"]); ok {
			if parsed, err := time.Parse(time.RFC3339, text); err == nil {
				return parsed, true
			}
		}
	}
	if weatherNode != nil {
		if text, ok := normalizeISOText(weatherNode["pubTime"]); ok {
			if parsed, err := time.Parse(time.RFC3339, text); err == nil {
				return parsed, true
			}
		}
	}
	return time.Time{}, false
}

// 第 index 个时点的展示文本与解析结果；缺逐时时间时按起点加 hour 递推。
func hourlyTimeAt(windValues []any, index int, startLine time.Time) (string, time.Time, bool) {
	if index < len(windValues) {
		if point, ok := asObject(windValues[index]); ok {
			if text, ok := normalizeISOText(point["datetime"]); ok {
				if parsed, err := time.Parse(time.RFC3339, text); err == nil {
					return text, parsed, true
				}
			}
		}
	}
	derived := startLine.Add(time.Duration(index) * time.Hour)
	return derived.Format(time.RFC3339), derived, true
}

// 逐日预报：温度 from 为最高、to 为最低；日期取 sunRiseSet.value[].from 的日历日，
// 缺失时以发布时间所在日为起点逐日递推。
func parseDailyForecast(forecastDaily map[string]any) []WeatherDailyItem {
	temperatureNode, _ := asObject(forecastDaily["temperature"])
	weatherNode, _ := asObject(forecastDaily["weather"])
	sunNode, _ := asObject(forecastDaily["sunRiseSet"])

	temperatures, ok := asArray(temperatureNode["value"])
	if !ok || len(temperatures) == 0 {
		return nil
	}
	var codes []any
	if weatherNode != nil {
		codes, _ = asArray(weatherNode["value"])
	}
	var sunValues []any
	if sunNode != nil {
		sunValues, _ = asArray(sunNode["value"])
	}

	baseDate, ok := dailyBaseDate(sunValues, forecastDaily)
	if !ok {
		return nil
	}

	items := make([]WeatherDailyItem, 0, DailyForecastLimit)
	for index := range temperatures {
		maxC, minC, ok := readDailyTemperature(temperatures[index])
		if !ok {
			continue
		}

		dateKey, ok := dailyDateAt(sunValues, index, baseDate)
		if !ok {
			continue
		}

		item := WeatherDailyItem{
			Date:            dateKey,
			TemperatureMaxC: math.Max(maxC, minC),
			TemperatureMinC: math.Min(maxC, minC),
		}
		if index < len(codes) {
			if code, ok := readDayWeatherCode(codes[index]); ok {
				text := ConditionText(code)
				item.WeatherCode = &code
				item.ConditionText = &text
			}
		}
		items = append(items, item)
		if len(items) >= DailyForecastLimit {
			break
		}
	}
	if len(items) == 0 {
		return nil
	}
	return items
}

// 单日温度：优先取对象里的 from/to，标量形态按同值处理。
func readDailyTemperature(node any) (float64, float64, bool) {
	object, ok := asObject(node)
	if !ok {
		value, ok := readUnitValue(node)
		if !ok {
			return 0, 0, false
		}
		return value, value, true
	}
	maxC, ok := readUnitValue(object["from"])
	if !ok {
		// from 缺失时退化为把整条当标量读，仍失败即丢弃该日
		if fallback, ok := readUnitValue(node); ok {
			maxC = fallback
		} else {
			return 0, 0, false
		}
	}
	minC, ok := readUnitValue(object["to"])
	if !ok {
		return 0, 0, false
	}
	return maxC, minC, true
}

// 日期基准：优先首条日出的日历日，其次逐日预报的发布时间。
func dailyBaseDate(sunValues []any, forecastDaily map[string]any) (string, bool) {
	if len(sunValues) > 0 {
		if first, ok := asObject(sunValues[0]); ok {
			if text, ok := normalizeISOText(first["from"]); ok {
				if dateKey, ok := dateKeyFromISO(text); ok {
					return dateKey, true
				}
			}
		}
	}
	if text, ok := normalizeISOText(forecastDaily["pubTime"]); ok {
		if dateKey, ok := dateKeyFromISO(text); ok {
			return dateKey, true
		}
	}
	return "", false
}

// 第 index 天的日期：优先该天日出的日历日，否则从基准日按天递推。
func dailyDateAt(sunValues []any, index int, baseDate string) (string, bool) {
	if index < len(sunValues) {
		if point, ok := asObject(sunValues[index]); ok {
			if text, ok := normalizeISOText(point["from"]); ok {
				if dateKey, ok := dateKeyFromISO(text); ok {
					return dateKey, true
				}
			}
		}
	}
	return addDaysToDateKey(baseDate, index)
}

// 时间文本必须是可解析的 ISO 8601，否则视为缺失。
func normalizeISOText(node any) (string, bool) {
	text, ok := node.(string)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	if _, err := time.Parse(time.RFC3339, trimmed); err != nil {
		return "", false
	}
	return trimmed, true
}

// 取 ISO 文本开头的日历日 YYYY-MM-DD；前缀不合法时按解析后的 UTC 日期回落。
func dateKeyFromISO(text string) (string, bool) {
	if len(text) >= len("2006-01-02") {
		candidate := text[:len("2006-01-02")]
		if _, err := time.Parse("2006-01-02", candidate); err == nil {
			return candidate, true
		}
	}
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return "", false
	}
	return parsed.UTC().Format("2006-01-02"), true
}

// 在日历日上加天数；入参不是合法 YYYY-MM-DD 时返回 false。
func addDaysToDateKey(dateKey string, days int) (string, bool) {
	parsed, err := time.Parse("2006-01-02", dateKey)
	if err != nil {
		return "", false
	}
	return parsed.AddDate(0, 0, days).Format("2006-01-02"), true
}

// 出站失败的归类：超时优先，其余都算不可达。
func isTimeoutErr(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
