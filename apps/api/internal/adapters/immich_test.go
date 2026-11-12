package adapters

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// 供测试使用的密钥；假服务会把收到的请求头回显出来供断言。
const immichTestKey = "immich-api-key-value"

// 按路径分发的假 Immich：v1、v2 两套统计与存储路径各自可覆写。
type fakeImmich struct {
	statisticsHandler http.HandlerFunc
	storageHandler    http.HandlerFunc
	requests          []string
	keys              []string
}

// 起一个假服务并返回其地址，同时记录请求路径与密钥。
func startImmich(t *testing.T, fake *fakeImmich) string {
	t.Helper()
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		fake.requests = append(fake.requests, r.URL.Path)
		fake.keys = append(fake.keys, r.Header.Get("X-API-Key"))

		switch r.URL.Path {
		case immichStatisticsPathV1, immichStatisticsPathV2:
			if fake.statisticsHandler != nil {
				fake.statisticsHandler(w, r)
				return
			}
			_, _ = w.Write([]byte(`{"users":2,"photos":10,"videos":3,"usage":1024}`))
		case immichStoragePathV2:
			if fake.storageHandler != nil {
				fake.storageHandler(w, r)
				return
			}
			_, _ = w.Write([]byte(`[{"diskUseRaw":2048}]`))
		default:
			http.NotFound(w, r)
		}
	})
	return server.URL
}

// 构造一次带密钥与选项的调用输入。
func immichInput(url string, options any) RunInput {
	return RunInput{URL: url, Secrets: map[string]string{"key": immichTestKey}, Options: options}
}

// 执行一次适配器调用并规范结果；适配器层不应向外抛错。
func runImmich(t *testing.T, input RunInput) ServiceWidgetResult {
	t.Helper()
	raw, err := immichAdapter{}.Run(context.Background(), input)
	if err != nil {
		t.Fatalf("适配器不应返回底层错误：%v", err)
	}
	return Validate(raw)
}

// 统计响应用最小的可解析对象；空表用于验证缺字段降级。
func immichStatistics(body string) *fakeImmich {
	return &fakeImmich{
		statisticsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(body))
		},
	}
}

func TestImmichAdapterIsRegistered(t *testing.T) {
	adapter, ok := Get("immich")
	if !ok {
		t.Fatal("immich 适配器应已登记到默认注册表")
	}
	if adapter.Type() != "immich" {
		t.Fatalf("类型名应为 immich，实得 %q", adapter.Type())
	}
}

func TestImmichMissingKeySendsNoRequest(t *testing.T) {
	fake := &fakeImmich{}

	for name, secrets := range map[string]map[string]string{
		"无密钥字段": {},
		"空白密钥":  {"key": "  "},
	} {
		result := runImmich(t, RunInput{URL: startImmich(t, fake), Secrets: secrets})
		if result.Ok {
			t.Fatalf("%s：缺少密钥必须失败", name)
		}
		if result.Error != immichMissingKey {
			t.Fatalf("%s：文案应为 %q，实得 %q", name, immichMissingKey, result.Error)
		}
	}
	if len(fake.requests) != 0 {
		t.Fatalf("缺少密钥不得发起请求，实得 %v", fake.requests)
	}
}

func TestImmichReadsAPIKeyFallbacks(t *testing.T) {
	// key 缺失时依次回退 apiKey 与 token，仍按 X-API-Key 发出
	for name, secrets := range map[string]map[string]string{
		"apiKey": {"apiKey": "second-choice"},
		"token":  {"token": "third-choice"},
	} {
		fake := &fakeImmich{}
		result := runImmich(t, RunInput{URL: startImmich(t, fake), Secrets: secrets})
		if !result.Ok {
			t.Fatalf("%s：应成功：%q", name, result.Error)
		}
		for _, got := range fake.keys {
			if got != secrets["apiKey"]+secrets["token"] {
				t.Fatalf("%s：应作为 X-API-Key 发出，实得 %q", name, got)
			}
		}
	}
}

func TestImmichDefaultsToV2Paths(t *testing.T) {
	fake := &fakeImmich{}
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if len(fake.requests) == 0 || fake.requests[0] != immichStatisticsPathV2 {
		t.Fatalf("默认应请求 v2 统计路径，实得 %v", fake.requests)
	}
}

func TestImmichUsesV1PathsWhenConfigured(t *testing.T) {
	fake := &fakeImmich{}
	result := runImmich(t, immichInput(startImmich(t, fake), map[string]any{"version": 1}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if fake.requests[0] != immichStatisticsPathV1 {
		t.Fatalf("version=1 应请求旧统计路径，实得 %v", fake.requests)
	}
}

func TestImmichVersionAcceptsStrings(t *testing.T) {
	for name, version := range map[string]any{"字符串 1": "1", "浮点 1": float64(1), "整数 1": 1} {
		got, _ := parseImmichOptions(map[string]any{"version": version})
		if got != 1 {
			t.Fatalf("%s：应解析为 1，实得 %d", name, got)
		}
	}
	for name, version := range map[string]any{"字符串 2": "2", "残缺": "1.5", "布尔": true} {
		got, _ := parseImmichOptions(map[string]any{"version": version})
		if version == "2" && got != 2 {
			t.Fatalf("%s：应解析为 2，实得 %d", name, got)
		}
		if version != "2" && got != 2 {
			t.Fatalf("%s：非法取值应按默认 2 处理，实得 %d", name, got)
		}
	}
}

func TestImmichBuildsFourMetrics(t *testing.T) {
	fake := immichStatistics(`{"users":2,"photos":10,"videos":3,"usage":1024}`)
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if len(result.Metrics) != 4 {
		t.Fatalf("应输出四项指标，实得 %d：%+v", len(result.Metrics), result.Metrics)
	}
	if got := metricByID(t, result.Metrics, immichUsersMetricID); got.Value != int64(2) || got.Label != "用户" {
		t.Fatalf("用户指标不符：%+v", got)
	}
	if got := metricByID(t, result.Metrics, immichPhotosMetricID); got.Value != int64(10) {
		t.Fatalf("照片应为 10，实得 %v", got.Value)
	}
	if got := metricByID(t, result.Metrics, immichVideosMetricID); got.Value != int64(3) {
		t.Fatalf("视频应为 3，实得 %v", got.Value)
	}

	// 1024 字节按 1000 进位到 1.02 KB
	storage := metricByID(t, result.Metrics, immichStorageMetricID)
	if storage.Unit != "KB" {
		t.Fatalf("存储单位应为 KB，实得 %q", storage.Unit)
	}
	if got, _ := CoerceFiniteNumber(storage.Value); got != 1.02 {
		t.Fatalf("存储数值应为 1.02，实得 %v", storage.Value)
	}
}

func TestImmichUsersFromUsageByUser(t *testing.T) {
	// usageByUser 是数组时按条目数当用户数，用量拆在各项里
	fake := immichStatistics(`{"usageByUser":[{"usage":600},{"usage":424}],"photos":5}`)
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if got := metricByID(t, result.Metrics, immichUsersMetricID); got.Value != int64(2) {
		t.Fatalf("用户数应取条目数 2，实得 %v", got.Value)
	}
	storage := metricByID(t, result.Metrics, immichStorageMetricID)
	if got, _ := CoerceFiniteNumber(storage.Value); got != 1.02 {
		t.Fatalf("存储应汇总各项 usage 得 1024，实得 %v", storage.Value)
	}
}

func TestImmichMissingFieldsMarkUnavailable(t *testing.T) {
	// 只有照片可解析：其余标不可用，照片保持 ok；存储接口也不可用时不伪造 0
	fake := &fakeImmich{
		statisticsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"photos":12}`))
		},
		storageHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		},
	}
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if got := metricByID(t, result.Metrics, immichPhotosMetricID); got.Status != MetricStatusOK || got.Value != int64(12) {
		t.Fatalf("照片应为 ok 且值 12：%+v", got)
	}
	for _, id := range []string{immichUsersMetricID, immichVideosMetricID, immichStorageMetricID} {
		got := metricByID(t, result.Metrics, id)
		if got.Status != MetricStatusUnavailable {
			t.Fatalf("%s 缺失时应标不可用，实得 %q", id, got.Status)
		}
		if got.Value != "—" {
			t.Fatalf("%s 缺失时应输出占位符，实得 %v", id, got.Value)
		}
	}
}

func TestImmichEmptyStatisticsWithStorageFillsOnlyStorage(t *testing.T) {
	// 统计全缺但存储接口可用时，其余三项标不可用，存储取补拉值
	fake := immichStatistics(`{}`)
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("存储可用时应成功：%q", result.Error)
	}
	if len(result.Metrics) != 4 {
		t.Fatalf("应输出四项指标，实得 %d：%+v", len(result.Metrics), result.Metrics)
	}
	if got := metricByID(t, result.Metrics, immichStorageMetricID); got.Status != MetricStatusOK {
		t.Fatalf("存储应可用，实得 %+v", got)
	}
	for _, id := range []string{immichUsersMetricID, immichPhotosMetricID, immichVideosMetricID} {
		if got := metricByID(t, result.Metrics, id); got.Status != MetricStatusUnavailable {
			t.Fatalf("%s 缺失时应标不可用，实得 %q", id, got.Status)
		}
	}
}

func TestImmichAllFieldsMissingFails(t *testing.T) {
	// 统计与存储都取不到任何字段时才整卡失败
	fake := &fakeImmich{
		statisticsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{}`))
		},
		storageHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		},
	}
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if result.Ok {
		t.Fatal("全部字段缺失必须失败")
	}
	if result.Error != immichStatsFields {
		t.Fatalf("文案应为 %q，实得 %q", immichStatsFields, result.Error)
	}
}

func TestImmichFieldWhitelist(t *testing.T) {
	fake := immichStatistics(`{"users":2,"photos":10,"videos":3,"usage":1024}`)
	result := runImmich(t, immichInput(startImmich(t, fake), map[string]any{"fields": []any{" PHOTOS ", "videos"}}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if len(result.Metrics) != 2 {
		t.Fatalf("白名单应只留两项，实得 %+v", result.Metrics)
	}
	metricByID(t, result.Metrics, immichPhotosMetricID)
	metricByID(t, result.Metrics, immichVideosMetricID)
}

func TestImmichStorageEndpointFillsMissingUsage(t *testing.T) {
	// 统计里没有用量时补拉存储接口；diskUseRaw 逐块累加
	fake := &fakeImmich{
		statisticsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"photos":10}`))
		},
		storageHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`[{"diskUseRaw":1000000},{"diskUseRaw":500000}]`))
		},
	}
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}

	storage := metricByID(t, result.Metrics, immichStorageMetricID)
	if storage.Status != MetricStatusOK {
		t.Fatalf("存储应可用，实得 %q", storage.Status)
	}
	// 合计 1500000 字节按 1000 进位到 1.5 MB
	if storage.Unit != "MB" {
		t.Fatalf("存储单位应为 MB，实得 %q", storage.Unit)
	}
	if got, _ := CoerceFiniteNumber(storage.Value); got != 1.5 {
		t.Fatalf("存储数值应为 1.5，实得 %v", storage.Value)
	}

	var queried bool
	for _, path := range fake.requests {
		if path == immichStoragePathV2 {
			queried = true
		}
	}
	if !queried {
		t.Fatalf("统计缺用量时应补拉存储接口，实得 %v", fake.requests)
	}
}

func TestImmichSkipsStorageEndpointWhenPresent(t *testing.T) {
	fake := immichStatistics(`{"photos":10,"usage":1024}`)
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	for _, path := range fake.requests {
		if path == immichStoragePathV2 {
			t.Fatalf("统计已带用量时不应再请求存储接口，实得 %v", fake.requests)
		}
	}
}

func TestImmichV1HasNoSeparateStorageEndpoint(t *testing.T) {
	// 旧版没有独立存储接口，用量只认统计响应自带的字段
	fake := immichStatistics(`{"photos":10}`)
	result := runImmich(t, immichInput(startImmich(t, fake), map[string]any{"version": 1}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	for _, path := range fake.requests {
		if path == immichStoragePathV2 {
			t.Fatalf("version=1 不应请求 v2 存储接口，实得 %v", fake.requests)
		}
	}
	if got := metricByID(t, result.Metrics, immichStorageMetricID); got.Status != MetricStatusUnavailable {
		t.Fatalf("存储应标不可用，实得 %q", got.Status)
	}
}

func TestImmichStorageFailureOnlyMarksThatMetric(t *testing.T) {
	// 存储接口不可用不应拖垮其余指标
	fake := &fakeImmich{
		statisticsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"photos":10}`))
		},
		storageHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		},
	}
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("存储失败不应拖垮整卡：%q", result.Error)
	}
	if got := metricByID(t, result.Metrics, immichStorageMetricID); got.Status != MetricStatusUnavailable {
		t.Fatalf("存储应标不可用，实得 %q", got.Status)
	}
}

func TestImmichRejectsNonObjectStatistics(t *testing.T) {
	fake := immichStatistics(`[1,2,3]`)
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if result.Ok {
		t.Fatal("非对象统计响应必须失败")
	}
	if result.Error != immichStatsFields {
		t.Fatalf("文案应为 %q，实得 %q", immichStatsFields, result.Error)
	}
}

func TestImmichStatisticsStatusFailure(t *testing.T) {
	fake := &fakeImmich{
		statisticsHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		},
	}
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if result.Ok {
		t.Fatal("401 必须失败")
	}
	if result.Error != immichStatsFail {
		t.Fatalf("文案应为 %q，实得 %q", immichStatsFail, result.Error)
	}
}

func TestImmichInvalidJSONKeepsLocalMessage(t *testing.T) {
	fake := immichStatistics(`not json`)
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if result.Ok {
		t.Fatal("非法 JSON 必须失败")
	}
	if result.Error != immichStatsBadJSON {
		t.Fatalf("文案应为 %q，实得 %q", immichStatsBadJSON, result.Error)
	}
}

func TestImmichNeverLeaksAPIKey(t *testing.T) {
	// 服务把密钥回显在正文里，失败文案仍不得带出
	fake := &fakeImmich{
		statisticsHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"message":"bad key ` + immichTestKey + `"}`))
		},
	}
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if result.Ok {
		t.Fatal("401 必须失败")
	}
	if ContainsAnySecret(result.Error, map[string]string{"key": immichTestKey}) {
		t.Fatalf("失败文案不得含密钥：%q", result.Error)
	}
	if strings.Contains(result.Error, "bad key") {
		t.Fatalf("失败文案不得带回响应正文：%q", result.Error)
	}
}

func TestImmichCountsAcceptStringNumbers(t *testing.T) {
	// 部分版本用字符串回数字，负值按 0
	fake := immichStatistics(`{"users":"2","photos":"-5","videos":"3"}`)
	result := runImmich(t, immichInput(startImmich(t, fake), nil))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if got := metricByID(t, result.Metrics, immichUsersMetricID); got.Value != int64(2) {
		t.Fatalf("用户应为 2，实得 %v", got.Value)
	}
	if got := metricByID(t, result.Metrics, immichPhotosMetricID); got.Value != int64(0) {
		t.Fatalf("负值应按 0，实得 %v", got.Value)
	}
}
