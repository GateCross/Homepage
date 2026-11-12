package docker

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
)

// 测试用端点：unix socket 不参与拨号，传输层已被替换。
func testEndpoint(t *testing.T) config.DockerEndpoint {
	t.Helper()
	endpoint, ok := config.ParseDockerEndpoint("unix:///var/run/docker.sock")
	if !ok {
		t.Fatal("构造端点失败")
	}
	return endpoint
}

// 单容器目标。
func testTarget(t *testing.T, server, container string) Target {
	t.Helper()
	return Target{Server: server, Container: container, Endpoint: testEndpoint(t)}
}

// 始终返回运行中详情报文。
func runningInspect(context.Context, string) (Response, error) {
	return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
}

func TestQueryDuplicateKeysHitTransportOnce(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	service := NewService(nil, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})
	target := testTarget(t, "local", "web")

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			item, ok := service.Query(context.Background(), target)
			if !ok || item.Result.Status != domain.DockerStatusRunning {
				t.Errorf("并发查询应返回运行中，实得 %+v", item.Result)
			}
		}()
	}
	wg.Wait()

	if got := transport.countPrefix("/containers/web/json"); got != 1 {
		t.Fatalf("10 次并发只应打一次 inspect，实际 %d 次", got)
	}
}

func TestQueryFullReusesFreshLiteWithoutInspect(t *testing.T) {
	cache := NewCache()
	cache.Set("local", "web", BucketLite, domain.DockerStatusResponse{
		Status: domain.DockerStatusRunning,
		Detail: strPtr("Up 3 hours"),
	})
	transport := &fakeTransport{handler: func(_ context.Context, path string) (Response, error) {
		if strings.HasPrefix(path, "/containers/web/stats") {
			return Response{StatusCode: 200, Body: statsBody(2000, 10000, 512, 1024)}, nil
		}
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	service := NewService(nil, Options{Cache: cache, Transport: transport, IncludeStats: true, Samples: NewCpuSampleStore()})

	item, ok := service.Query(context.Background(), testTarget(t, "local", "web"))
	if !ok || item.Result.Status != domain.DockerStatusRunning {
		t.Fatalf("应返回运行中，实得 %+v", item.Result)
	}
	if got := transport.countPrefix("/containers/web/json"); got != 0 {
		t.Fatalf("命中新鲜 lite 时不得重复 inspect，实际 %d 次", got)
	}
	if got := transport.countPrefix("/containers/web/stats"); got == 0 {
		t.Fatal("命中新鲜 lite 时必须补拉 stats")
	}
	if item.Result.MemoryLimitBytes == nil {
		t.Fatal("补拉 stats 后应带内存上限")
	}
	if item.Result.Detail == nil || *item.Result.Detail != "Up 3 hours" {
		t.Fatal("合并 stats 时不得丢失 lite 的细节字段")
	}
}

func TestQueryStatsFailureDegradesAndSkipsCache(t *testing.T) {
	cache := NewCache()
	cache.Set("local", "web", BucketLite, domain.DockerStatusResponse{Status: domain.DockerStatusRunning})
	transport := &fakeTransport{handler: func(_ context.Context, path string) (Response, error) {
		return Response{}, &Error{Kind: KindUnreachable, Message: "Docker 端点不可达"}
	}}
	service := NewService(nil, Options{Cache: cache, Transport: transport, IncludeStats: true, Samples: NewCpuSampleStore()})

	item, ok := service.Query(context.Background(), testTarget(t, "local", "web"))
	if !ok {
		t.Fatal("stats 失败不得中断查询")
	}
	if item.Result.Status != domain.DockerStatusRunning {
		t.Fatalf("stats 失败应降级为运行中，实得 %q", item.Result.Status)
	}
	if item.Result.CPUPercent != nil || item.Result.MemoryPercent != nil {
		t.Fatal("降级结果不得带资源指标")
	}
	if hit := cache.Lookup("local", "web", BucketFull); hit.Kind != HitMiss {
		t.Fatal("降级结果不得写入 full 缓存")
	}
}

func TestQueryStaleServesOldValueAndRefreshes(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	cache := NewCacheWithTTL(FreshTTL, StaleTTL, clock.Now)
	cache.Set("local", "web", BucketFull, domain.DockerStatusResponse{Status: domain.DockerStatusStopped})

	clock.Advance(FreshTTL + time.Second)
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	service := NewService(nil, Options{
		Cache:        cache,
		Transport:    transport,
		IncludeStats: true,
		Samples:      NewCpuSampleStore(),
		Now:          clock.Now,
	})

	item, ok := service.Query(context.Background(), testTarget(t, "local", "web"))
	if !ok || item.Result.Status != domain.DockerStatusStopped {
		t.Fatalf("stale 应先返回旧值，实得 %+v", item.Result)
	}

	// 等待后台刷新落缓存，刷新后 full 桶应转新鲜
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hit := cache.Lookup("local", "web", BucketFull); hit.Kind == HitFresh {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("后台刷新未在期限内续期缓存")
}

func TestCollectKeepsTargetOrder(t *testing.T) {
	// 让先登记的目标更晚返回，验证数组响应仍按目标顺序排列
	transport := &fakeTransport{handler: func(ctx context.Context, path string) (Response, error) {
		if strings.Contains(path, "/a1/") {
			time.Sleep(30 * time.Millisecond)
		}
		return Response{StatusCode: 200, Body: inspectBody("running", true, 1)}, nil
	}}
	allowList := testAllowList(t, "a1", "b2", "c3")
	service := NewService(ListTargets(allowList), Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	items := service.Collect(context.Background())
	want := []string{"a1", "b2", "c3"}
	if len(items) != len(want) {
		t.Fatalf("应返回 %d 条，实得 %d", len(want), len(items))
	}
	for i, name := range want {
		if items[i].Container != name {
			t.Fatalf("第 %d 条应为 %q，实得 %q", i, name, items[i].Container)
		}
	}
}

func TestCanceledQueryDoesNotWriteCache(t *testing.T) {
	transport := &fakeTransport{handler: func(ctx context.Context, _ string) (Response, error) {
		return Response{}, ctx.Err()
	}}
	cache := NewCache()
	allowList := testAllowList(t, "web")
	service := NewService(ListTargets(allowList), Options{
		Cache:     cache,
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := service.Query(ctx, service.targets[0]); ok {
		t.Fatal("取消后不得返回结果")
	}
	if hit := cache.Lookup("local", "web", BucketLite); hit.Kind != HitMiss {
		t.Fatal("取消的查询不得写入缓存")
	}
}

func TestInspectErrorKindsMapToUnavailable(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		reason string
	}{
		{name: "超时", err: &Error{Kind: KindTimeout, Message: "查询 Docker 超时"}, reason: "查询 Docker 超时"},
		{name: "不存在", err: &Error{Kind: KindNotFound, Message: "容器不存在"}, reason: "容器不存在"},
		{name: "不可达", err: &Error{Kind: KindUnreachable, Message: "Docker 端点不可达"}, reason: "Docker 端点不可达"},
		{name: "普通错误", err: errors.New("boom"), reason: "Docker 端点不可达"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := NewClient(testEndpoint(t), ClientOptions{
				Transport: &fakeTransport{handler: func(context.Context, string) (Response, error) {
					return Response{}, testCase.err
				}},
				Samples: NewCpuSampleStore(),
			})
			status, err := client.Inspect(context.Background(), "web")
			if err != nil {
				t.Fatalf("Docker 侧失败不应以错误返回：%v", err)
			}
			if status.Status != domain.DockerStatusUnavailable {
				t.Fatalf("应为 unavailable，实得 %q", status.Status)
			}
			if status.Reason == nil || *status.Reason != testCase.reason {
				t.Fatalf("原因应为 %q，实得 %v", testCase.reason, status.Reason)
			}
		})
	}
}

func TestInspectCanceledContextReturnsError(t *testing.T) {
	client := NewClient(testEndpoint(t), ClientOptions{
		Transport: &fakeTransport{handler: func(ctx context.Context, _ string) (Response, error) {
			return Response{}, ctx.Err()
		}},
		Samples: NewCpuSampleStore(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Inspect(ctx, "web"); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消应返回 ctx 错误，实得 %v", err)
	}
}
