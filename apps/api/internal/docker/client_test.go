package docker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
)

// 构造带一次补拉计数确认的客户端。
func newSampleClient(t *testing.T, transport Transport) *Client {
	t.Helper()
	return NewClient(testEndpoint(t), ClientOptions{
		Transport: transport,
		Samples:   NewCpuSampleStore(),
		SeedGap:   time.Millisecond,
	})
}

func TestStatsUsesPreviousSampleForCPUPercent(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: statsBody(2000, 10000, 512, 1024)}, nil
	}}
	client := newSampleClient(t, transport)
	key := client.sampleKey("web")

	// 上一拍：total=1000，system=5000，间隔 10s
	client.samples.set(key, CpuCounterSample{
		TotalUsage:  1000,
		SystemUsage: 5000,
		At:          client.now().Add(-10 * time.Second),
	})

	stats, err := client.Stats(context.Background(), "web")
	if err != nil {
		t.Fatalf("查询 stats 失败：%v", err)
	}
	if stats.CPUPercent == nil {
		t.Fatal("有上一拍时应算出 CPU 占用")
	}
	// (2000-1000)/(10000-5000)*100 = 20%，即占宿主全部算力的比例
	if got := *stats.CPUPercent; got < 19.9 || got > 20.1 {
		t.Fatalf("CPU 百分比应为 20，实得 %v", got)
	}
	if got := transport.count(); got != 1 {
		t.Fatalf("有上一拍时只应请求一次，实际 %d 次", got)
	}
}

func TestStatsSeedsSecondSampleWhenNoPrevious(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: statsBody(2000, 10000, 512, 1024)}, nil
	}}
	client := newSampleClient(t, transport)

	stats, err := client.Stats(context.Background(), "web")
	if err != nil {
		t.Fatalf("查询 stats 失败：%v", err)
	}
	if got := transport.count(); got != 2 {
		t.Fatalf("没有上一拍时应补拉第二拍，实际 %d 次", got)
	}
	if stats.MemoryPercent == nil || *stats.MemoryPercent != 50 {
		t.Fatalf("内存占用应为 50%%，实得 %v", stats.MemoryPercent)
	}
	if stats.CPUPercent != nil {
		t.Fatalf("两拍计数相同不应算出 CPU%%：%v", *stats.CPUPercent)
	}
}

func TestStatsPrefersPreviousSampleOverZeroPrecpu(t *testing.T) {
	// one-shot 常见形态：precpu 全 0，只有 cpu_stats 有值
	body := []byte(`{"cpu_stats":{"cpu_usage":{"total_usage":3000},"system_cpu_usage":9000,"online_cpus":4},` +
		`"precpu_stats":{"cpu_usage":{"total_usage":0},"system_cpu_usage":0},` +
		`"memory_stats":{"usage":256,"limit":1024}}`)
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: body}, nil
	}}
	client := newSampleClient(t, transport)
	client.samples.set(client.sampleKey("web"), CpuCounterSample{
		TotalUsage:  2000,
		SystemUsage: 8000,
		At:          client.now().Add(-time.Second),
	})

	stats, err := client.Stats(context.Background(), "web")
	if err != nil {
		t.Fatalf("查询 stats 失败：%v", err)
	}
	if stats.CPUPercent == nil {
		t.Fatal("应使用进程内上一拍算出 CPU 占用")
	}
	// (3000-2000)/(9000-8000)*100 = 100%，整台宿主算力全被吃满
	if got := *stats.CPUPercent; got != 100 {
		t.Fatalf("CPU 百分比应为 100，实得 %v", got)
	}
	if got := transport.count(); got != 1 {
		t.Fatalf("有上一拍时不得补拉第二拍，实际 %d 次", got)
	}
}

func TestStatsFailsWhenPayloadUnavailable(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{}, &Error{Kind: KindUnreachable, Message: "Docker 端点不可达"}
	}}
	client := newSampleClient(t, transport)

	if _, err := client.Stats(context.Background(), "web"); err == nil {
		t.Fatal("stats 失败必须返回错误，供调用方降级且不写缓存")
	}
}

func TestFetchStatsKeepsFirstShotWhenSeedFails(t *testing.T) {
	calls := 0
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		calls++
		if calls == 1 {
			return Response{StatusCode: 200, Body: statsBody(2000, 10000, 512, 1024)}, nil
		}
		return Response{}, &Error{Kind: KindTimeout, Message: "查询 Docker 超时"}
	}}
	client := newSampleClient(t, transport)

	stats, err := client.Stats(context.Background(), "web")
	if err != nil {
		t.Fatalf("第二拍失败不应整体报错：%v", err)
	}
	if stats.MemoryLimitBytes == nil {
		t.Fatal("第二拍失败时应保留第一拍的内存数据")
	}
}

func TestInspectMapsStates(t *testing.T) {
	cases := []struct {
		name   string
		body   []byte
		status string
	}{
		{name: "运行中", body: inspectBody("running", true, 42), status: domain.DockerStatusRunning},
		{name: "已停止", body: inspectBody("exited", false, 0), status: domain.DockerStatusStopped},
		{name: "重启中", body: []byte(`{"State":{"Status":"restarting","Restarting":true}}`), status: domain.DockerStatusRestarting},
		{name: "暂停", body: []byte(`{"State":{"Status":"paused","Paused":true}}`), status: domain.DockerStatusPaused},
		{name: "创建中", body: []byte(`{"State":{"Status":"created"}}`), status: domain.DockerStatusStarting},
		{name: "健康状态", body: []byte(`{"State":{"Status":"running","Running":true,"Health":{"Status":"healthy"}}}`), status: domain.DockerStatusRunning},
		{name: "异常结构", body: []byte(`[]`), status: domain.DockerStatusUnavailable},
		{name: "无效 JSON", body: []byte(`{`), status: domain.DockerStatusUnavailable},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := NewClient(testEndpoint(t), ClientOptions{
				Transport: &fakeTransport{handler: func(context.Context, string) (Response, error) {
					return Response{StatusCode: 200, Body: testCase.body}, nil
				}},
				Samples: NewCpuSampleStore(),
			})
			status, err := client.Inspect(context.Background(), "web")
			if err != nil {
				t.Fatalf("查询失败：%v", err)
			}
			if status.Status != testCase.status {
				t.Fatalf("状态应为 %q，实得 %q", testCase.status, status.Status)
			}
		})
	}
}

func TestClientRejectsNonWhitelistedPaths(t *testing.T) {
	transport := NewHTTPTransport()
	endpoint := testEndpoint(t)

	allowed := []string{
		"/containers/web/json",
		"/containers/web/stats?stream=0&one-shot=1",
		"/containers/json",
		// 列表接口实际请求的是带 all=true 的形态，必须放行
		listAllPath,
	}
	for _, path := range allowed {
		if !isAllowedReadPath(path) {
			t.Fatalf("路径应被放行：%s", path)
		}
	}

	rejected := []string{
		"/containers/web/start",
		"/containers/web/stats",
		"/containers/web/stats?stream=1",
		"/containers/web/stats?stream=0&all=true",
		"/containers/web/logs?follow=1",
		"/containers/../json",
		"/images/json",
		"/containers/web/json/",
		// 列表查询只允许 all=true，其它参数不得放行
		"/containers/json?all=false",
		"/containers/json?all=true&size=1",
	}
	for _, path := range rejected {
		if isAllowedReadPath(path) {
			t.Fatalf("路径必须被拒绝：%s", path)
		}
	}

	// 非 GET 在拨号前即被拒绝，不会触达真实端点
	if _, err := transport.Do(context.Background(), endpoint, Request{Method: "POST", Path: "/containers/web/json"}); err == nil {
		t.Fatal("非 GET 请求必须被拒绝")
	}
}

func TestBuildPathsEscapeContainerName(t *testing.T) {
	path, err := buildInspectPath("web")
	if err != nil || path != "/containers/web/json" {
		t.Fatalf("详情路径不正确：%s %v", path, err)
	}
	statsPath, err := buildStatsPath("web")
	if err != nil || statsPath != "/containers/web/stats?stream=0&one-shot=1" {
		t.Fatalf("stats 路径不正确：%s %v", statsPath, err)
	}
	if _, err := buildInspectPath("../etc"); err == nil {
		t.Fatal("含上跳片段的容器名必须被拒绝")
	}
	if _, err := buildStatsPath("  "); err == nil {
		t.Fatal("空容器名必须被拒绝")
	}
}

func TestHTTPTransportRejectsBeforeDialing(t *testing.T) {
	// 未监听的地址：若发生拨号会返回 unreachable，这里验证的是路径白名单先拦下
	endpoint, ok := config.ParseDockerEndpoint("tcp://127.0.0.1:1")
	if !ok {
		t.Fatal("构造端点失败")
	}
	transport := NewHTTPTransport()

	_, err := transport.Do(context.Background(), endpoint, Request{Method: "DELETE", Path: "/containers/web/json"})
	var dockerErr *Error
	if !errors.As(err, &dockerErr) || dockerErr.Kind != KindInvalid {
		t.Fatalf("非 GET 应返回 invalid，实得 %v", err)
	}

	_, err = transport.Do(context.Background(), endpoint, Request{Method: "GET", Path: "/containers/web/start"})
	if !errors.As(err, &dockerErr) || dockerErr.Kind != KindInvalid {
		t.Fatalf("白名单外路径应返回 invalid，实得 %v", err)
	}

	// 合法路径才真正拨号，不可达端点归类为 unreachable
	_, err = transport.Do(context.Background(), endpoint, Request{Method: "GET", Path: "/containers/web/json"})
	if !errors.As(err, &dockerErr) || dockerErr.Kind != KindUnreachable {
		t.Fatalf("不可达端点应返回 unreachable，实得 %v", err)
	}
}

func TestHTTPTransportHonorsContextCancel(t *testing.T) {
	endpoint, ok := config.ParseDockerEndpoint("tcp://192.0.2.1:2375")
	if !ok {
		t.Fatal("构造端点失败")
	}
	transport := NewHTTPTransport()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	// 文档保留地址，必然超时
	if _, err := transport.Do(ctx, endpoint, Request{Method: "GET", Path: "/containers/web/json"}); err == nil {
		t.Fatal("超时应返回错误")
	}
}

func TestCacheSetEvictsExpiredEntries(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	cache := NewCacheWithTTL(FreshTTL, StaleTTL, clock.Now)

	cache.Set("local", "old", BucketLite, runningValue())
	clock.Advance(StaleTTL + time.Second)
	cache.Set("local", "new", BucketLite, runningValue())

	cache.mu.Lock()
	_, kept := cache.entries[cacheKey("local", "old", BucketLite)]
	cache.mu.Unlock()
	if kept {
		t.Fatal("过期条目应在写入时被清理")
	}
}
