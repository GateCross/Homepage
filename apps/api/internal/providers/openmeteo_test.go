package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 固定「现在」，让逐小时过滤与逐日日期可预期。
var testNow = time.Date(2026, 3, 10, 9, 10, 0, 0, time.UTC)

// 完整的天气响应样本，覆盖当前、空气质量、逐小时与逐日四段。
const fullWeatherPayload = `{
  "current": {
    "temperature": {"value": 18.5},
    "weather": 1,
    "humidity": {"value": 62},
    "feelsLike": 17.2,
    "wind": {"speed": {"value": 12.3}, "direction": {"value": 135}},
    "uvIndex": "4",
    "pressure": {"value": 1008}
  },
  "aqi": {"aqi": 72},
  "forecastHourly": {
    "temperature": {"pubTime": "2026-03-10T08:00:00.000+08:00", "value": [{"value": 17.1}, {"value": 18.2}, {"value": 19.3}]},
    "weather": {"value": [1, 2, 3]},
    "wind": {"value": [
      {"datetime": "2026-03-10T08:00:00.000+08:00"},
      {"datetime": "2026-03-10T09:00:00.000+08:00"},
      {"datetime": "2026-03-10T10:00:00.000+08:00"}
    ]}
  },
  "forecastDaily": {
    "pubTime": "2026-03-10T07:00:00.000+08:00",
    "temperature": {"value": [{"from": 22, "to": 13}, {"from": 24, "to": 14}]},
    "weather": {"value": [{"from": 0, "to": 2}, {"from": 1}]},
    "sunRiseSet": {"value": [
      {"from": "2026-03-10T06:48:00.000+08:00", "to": "2026-03-10T18:52:00.000+08:00"},
      {"from": "2026-03-11T06:47:00.000+08:00", "to": "2026-03-11T18:53:00.000+08:00"}
    ]}
  }
}`

// 解一份 JSON 样本到通用结构，供转换测试直接使用。
func decodePayload(t *testing.T, raw string) map[string]any {
	t.Helper()
	payload, err := decodeJSONObject([]byte(raw))
	if err != nil {
		t.Fatalf("样本 JSON 解析失败：%v", err)
	}
	return payload
}

// 完整样本应逐字段落到契约结构上。
func TestConvertWeatherPayloadFull(t *testing.T) {
	info, err := convertWeatherPayload(decodePayload(t, fullWeatherPayload), "绵阳", testNow)
	if err != nil {
		t.Fatalf("转换失败：%v", err)
	}
	if info.TemperatureC != 18.5 {
		t.Errorf("温度 %v，期望 18.5", info.TemperatureC)
	}
	if info.Location == nil || *info.Location != "绵阳" {
		t.Errorf("地点为 %v，期望绵阳", info.Location)
	}
	if info.WeatherCode == nil || *info.WeatherCode != 1 {
		t.Errorf("天气码为 %v，期望 1", info.WeatherCode)
	}
	if info.ConditionText == nil || *info.ConditionText != "多云" {
		t.Errorf("天气描述为 %v，期望多云", info.ConditionText)
	}
	if info.HumidityPercent == nil || *info.HumidityPercent != 62 {
		t.Errorf("湿度为 %v，期望 62", info.HumidityPercent)
	}
	if info.FeelsLikeC == nil || *info.FeelsLikeC != 17.2 {
		t.Errorf("体感为 %v，期望 17.2", info.FeelsLikeC)
	}
	if info.WindSpeedKmh == nil || *info.WindSpeedKmh != 12.3 {
		t.Errorf("风速为 %v，期望 12.3", info.WindSpeedKmh)
	}
	if info.WindDirectionDeg == nil || *info.WindDirectionDeg != 135 {
		t.Errorf("风向为 %v，期望 135", info.WindDirectionDeg)
	}
	if info.UVIndex == nil || *info.UVIndex != 4 {
		t.Errorf("紫外线为 %v，期望 4", info.UVIndex)
	}
	if info.PressureHpa == nil || *info.PressureHpa != 1008 {
		t.Errorf("气压为 %v，期望 1008", info.PressureHpa)
	}
	if info.Aqi == nil || *info.Aqi != 72 {
		t.Errorf("AQI 为 %v，期望 72", info.Aqi)
	}
	if info.Sunrise == nil || *info.Sunrise != "2026-03-10T06:48:00.000+08:00" {
		t.Errorf("日出为 %v", info.Sunrise)
	}
	if info.Sunset == nil || *info.Sunset != "2026-03-10T18:52:00.000+08:00" {
		t.Errorf("日落为 %v", info.Sunset)
	}
	if len(info.Daily) != 2 {
		t.Fatalf("逐日条数 %d，期望 2", len(info.Daily))
	}
	if info.Daily[0].Date != "2026-03-10" || info.Daily[0].TemperatureMaxC != 22 || info.Daily[0].TemperatureMinC != 13 {
		t.Errorf("首日数据异常：%+v", info.Daily[0])
	}
	if info.Daily[0].WeatherCode == nil || *info.Daily[0].WeatherCode != 0 {
		t.Errorf("首日天气码为 %v，期望 0", info.Daily[0].WeatherCode)
	}
}

// 已过去超过半小时的逐小时点被丢弃，当前整点保留。
func TestConvertWeatherPayloadDropsPastHourly(t *testing.T) {
	info, err := convertWeatherPayload(decodePayload(t, fullWeatherPayload), "绵阳", testNow)
	if err != nil {
		t.Fatalf("转换失败：%v", err)
	}
	// 样本时间均带 +08:00：08:00 与 09:00 对应 UTC 00:00、01:00，均早于基准，全部过期
	if len(info.Hourly) != 0 {
		t.Fatalf("逐小时条数 %d，期望 0：%+v", len(info.Hourly), info.Hourly)
	}

	// 以样本首个时点前半小时为基准，三条都还在未来
	early := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)
	info, err = convertWeatherPayload(decodePayload(t, fullWeatherPayload), "绵阳", early)
	if err != nil {
		t.Fatalf("转换失败：%v", err)
	}
	if len(info.Hourly) != 3 {
		t.Fatalf("逐小时条数 %d，期望 3", len(info.Hourly))
	}
	if info.Hourly[0].Time != "2026-03-10T08:00:00.000+08:00" {
		t.Errorf("首点时间为 %q", info.Hourly[0].Time)
	}
	if info.Hourly[0].ConditionText == nil || *info.Hourly[0].ConditionText != "多云" {
		t.Errorf("首点描述为 %v，期望多云", info.Hourly[0].ConditionText)
	}
}

// 缺风.datetime 时以温度发布时间递推整点，并截断到 24 条。
func TestParseHourlyForecastFallsBackToPubTime(t *testing.T) {
	const payload = `{"forecastHourly": {
      "temperature": {"pubTime": "2026-03-10T08:00:00Z", "value": [
        {"value": 1}, {"value": 2}, {"value": 3}, {"value": 4}
      ]}
    }}`
	early := time.Date(2026, 3, 10, 7, 0, 0, 0, time.UTC)
	items := parseHourlyForecast(decodePayload(t, payload)["forecastHourly"], early)
	if len(items) != 4 {
		t.Fatalf("条数 %d，期望 4", len(items))
	}
	want := []string{"2026-03-10T08:00:00Z", "2026-03-10T09:00:00Z", "2026-03-10T10:00:00Z", "2026-03-10T11:00:00Z"}
	for index, item := range items {
		if item.Time != want[index] {
			t.Errorf("第 %d 点时间为 %q，期望 %q", index, item.Time, want[index])
		}
		if item.WeatherCode != nil || item.ConditionText != nil {
			t.Errorf("第 %d 点无状况码却带上了天气字段", index)
		}
	}
}

// 逐小时超过 24 条只保留前 24 条。
func TestParseHourlyForecastLimit(t *testing.T) {
	values := make([]string, 0, 40)
	for index := 0; index < 40; index++ {
		values = append(values, `{"value": 10}`)
	}
	payload := `{"forecastHourly": {"temperature": {"pubTime": "2026-03-10T00:00:00Z", "value": [` +
		strings.Join(values, ",") + `]}}}`
	items := parseHourlyForecast(decodePayload(t, payload)["forecastHourly"],
		time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC))
	if len(items) != HourlyForecastLimit {
		t.Fatalf("条数 %d，期望 %d", len(items), HourlyForecastLimit)
	}
}

// 逐日缺 sunRiseSet 时以发布时间所在日为起点按天递推，高温与低温不颠倒。
func TestParseDailyForecastFallbackDate(t *testing.T) {
	const payload = `{
      "pubTime": "2026-03-10T07:00:00.000+08:00",
      "temperature": {"value": [{"from": 13, "to": 22}, {"from": 24, "to": 14}]},
      "weather": {"value": [{"from": 3}, {"to": 7}]}
    }`
	items := parseDailyForecast(decodePayload(t, payload))
	if len(items) != 2 {
		t.Fatalf("条数 %d，期望 2", len(items))
	}
	if items[0].Date != "2026-03-10" || items[1].Date != "2026-03-11" {
		t.Errorf("日期轴为 %q / %q", items[0].Date, items[1].Date)
	}
	if items[0].TemperatureMaxC != 22 || items[0].TemperatureMinC != 13 {
		t.Errorf("首日高低温度颠倒：%+v", items[0])
	}
}

// 逐日缺逐日数组时不给 daily 字段。
func TestParseDailyForecastEmpty(t *testing.T) {
	if items := parseDailyForecast(decodePayload(t, `{}`)); items != nil {
		t.Errorf("空输入得到 %+v，期望 nil", items)
	}
}

// AQI 无法确认为国标口径时整字段不输出，也不能被美标数值顶替。
func TestAqiOmittedWhenNotChinaStandard(t *testing.T) {
	cases := []struct {
		name    string
		payload string
	}{
		{"根级没有空气质量", `{"current": {"temperature": 20}}`},
		{"aqi 节点不是对象", `{"current": {"temperature": 20}, "aqi": 68}`},
		{"aqi 子字段缺失", `{"current": {"temperature": 20}, "aqi": {"us": 68}}`},
		{"aqi 为空数组", `{"current": {"temperature": 20}, "aqi": []}`},
		{"aqi 超过五千上限", `{"current": {"temperature": 20}, "aqi": {"aqi": 501}}`},
		{"aqi 为负值", `{"current": {"temperature": 20}, "aqi": {"aqi": -3}}`},
		{"aqi 为不可解析文本", `{"current": {"temperature": 20}, "aqi": {"aqi": "良好"}}`},
		{"aqi 是带 value 的对象", `{"current": {"temperature": 20}, "aqi": {"aqi": {"value": 68}}}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			info, err := convertWeatherPayload(decodePayload(t, testCase.payload), "绵阳", testNow)
			if err != nil {
				t.Fatalf("转换失败：%v", err)
			}
			if info.Aqi != nil {
				t.Fatalf("AQI 为 %v，期望字段缺失", *info.Aqi)
			}
			// 序列化后字段必须整体消失，前端才不会读到 null 或 0
			encoded, err := json.Marshal(info)
			if err != nil {
				t.Fatalf("序列化失败：%v", err)
			}
			if strings.Contains(string(encoded), `"aqi"`) {
				t.Fatalf("序列化结果仍含 aqi：%s", encoded)
			}
		})
	}
}

// 国标 AQI 取值四舍五入为整数。
func TestParseChinaAqiRounding(t *testing.T) {
	value, ok := parseChinaAqi(map[string]any{"aqi": 72.6})
	if !ok || value != 73 {
		t.Fatalf("AQI 为 %v（ok=%v），期望 73", value, ok)
	}
}

// 缺少当前温度或当前节点时整体失败。
func TestConvertWeatherPayloadRejectsMissingTemperature(t *testing.T) {
	for _, payload := range []string{
		`{}`,
		`{"current": {}}`,
		`{"current": {"weather": 1}}`,
		`{"current": {"temperature": "abc"}}`,
	} {
		if _, err := convertWeatherPayload(decodePayload(t, payload), "绵阳", testNow); err == nil {
			t.Errorf("样本 %s 未报错", payload)
		}
	}
}

// 没有状况码时补「未知」描述，满足契约里两者至少给一个的要求。
func TestConvertWeatherPayloadFallsBackToUnknownCondition(t *testing.T) {
	info, err := convertWeatherPayload(decodePayload(t, `{"current": {"temperature": 20}}`), "绵阳", testNow)
	if err != nil {
		t.Fatalf("转换失败：%v", err)
	}
	if info.WeatherCode != nil {
		t.Errorf("天气码为 %v，期望缺失", *info.WeatherCode)
	}
	if info.ConditionText == nil || *info.ConditionText != unknownConditionText {
		t.Errorf("描述为 %v，期望 %q", info.ConditionText, unknownConditionText)
	}
}

// 越界数值不进入结果：湿度、气压、紫外线、风向都按区间过滤。
func TestConvertWeatherPayloadDropsOutOfRangeValues(t *testing.T) {
	const payload = `{"current": {
      "temperature": 20,
      "humidity": 130,
      "pressure": 12,
      "uvIndex": 30,
      "wind": {"speed": -1, "direction": 400}
    }}`
	info, err := convertWeatherPayload(decodePayload(t, payload), "绵阳", testNow)
	if err != nil {
		t.Fatalf("转换失败：%v", err)
	}
	if info.HumidityPercent != nil || info.PressureHpa != nil || info.UVIndex != nil ||
		info.WindSpeedKmh != nil || info.WindDirectionDeg != nil {
		t.Fatalf("越界值未被丢弃：%+v", info)
	}
}

// 请求地址必须带 weathercn 前缀与鉴权参数，城市编码非法时拒绝拼地址。
func TestBuildWeatherURL(t *testing.T) {
	requestURL, ok := buildWeatherURL("https://example.invalid/wtr-v3/weather/all", "101270401")
	if !ok {
		t.Fatal("合法城市编码被拒绝")
	}
	for _, want := range []string{
		"locationKey=weathercn%3A101270401",
		"appKey=weather20151024",
		"sign=zUFJoAR2ZVrDy1vF3D07",
		"days=7",
		"isGlobal=false",
		"locale=zh_cn",
		"latitude=0",
		"longitude=0",
	} {
		if !strings.Contains(requestURL, want) {
			t.Errorf("地址缺少 %q：%s", want, requestURL)
		}
	}
}

// 非数字、过短与过长的城市编码一律拒绝。
func TestBuildWeatherURLRejectsInvalidCityID(t *testing.T) {
	for _, cityID := range []string{"", "10127", "1012704011234", "10127040a", "abc12345"} {
		if _, ok := buildWeatherURL(XiaomiWeatherBaseURL, cityID); ok {
			t.Errorf("城市编码 %q 未被拒绝", cityID)
		}
	}
}

// 走 HTTP 服务端到端：合法响应转换成功，非 2xx 与坏 JSON 各自报错。
func TestWeatherClientFetch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("locationKey"); got != "weathercn:101270401" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fullWeatherPayload))
	}))
	defer server.Close()

	client := NewWeatherClient(WeatherClientOptions{
		BaseURL: server.URL,
		Timeout: time.Second,
		Now:     func() time.Time { return testNow },
	})
	info, err := client.Fetch(context.Background(), OpenMeteoTarget{CityID: "101270401", Location: "绵阳"})
	if err != nil {
		t.Fatalf("拉取失败：%v", err)
	}
	if info.TemperatureC != 18.5 {
		t.Errorf("温度为 %v，期望 18.5", info.TemperatureC)
	}
	if info.Location == nil || *info.Location != "绵阳" {
		t.Errorf("地点为 %v", info.Location)
	}
}

// 非 2xx 归类为不可用。
func TestWeatherClientFetchServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := NewWeatherClient(WeatherClientOptions{BaseURL: server.URL, Timeout: time.Second})
	if _, err := client.Fetch(context.Background(), OpenMeteoTarget{CityID: "101270401", Location: "绵阳"}); err != ErrWeatherUnavailable {
		t.Fatalf("错误为 %v，期望 %v", err, ErrWeatherUnavailable)
	}
}

// 非 JSON 响应归类为数据异常。
func TestWeatherClientFetchInvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>oops</html>"))
	}))
	defer server.Close()

	client := NewWeatherClient(WeatherClientOptions{BaseURL: server.URL, Timeout: time.Second})
	if _, err := client.Fetch(context.Background(), OpenMeteoTarget{CityID: "101270401", Location: "绵阳"}); err != ErrWeatherInvalid {
		t.Fatalf("错误为 %v，期望 %v", err, ErrWeatherInvalid)
	}
}

// 城市编码非法时不发起请求。
func TestWeatherClientFetchRejectsInvalidCity(t *testing.T) {
	client := NewWeatherClient(WeatherClientOptions{BaseURL: "https://example.invalid/wtr-v3/weather/all", Timeout: time.Second})
	if _, err := client.Fetch(context.Background(), OpenMeteoTarget{CityID: "abc", Location: "绵阳"}); err != ErrWeatherInvalid {
		t.Fatalf("错误为 %v，期望 %v", err, ErrWeatherInvalid)
	}
}
