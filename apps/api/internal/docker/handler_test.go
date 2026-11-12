package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
)

// 构造含单个端点与若干容器的允许列表。
func testAllowList(t *testing.T, containers ...string) *config.AllowList {
	t.Helper()
	allowList := config.NewAllowList()
	allowList.DockerEndpoints["local"] = testEndpoint(t)
	for _, container := range containers {
		allowList.DockerContainers[config.DockerContainerKey("local", container)] = struct{}{}
	}
	return allowList
}

func TestHandlerUnauthorizedIssuesNoDockerRequest(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	// 允许列表只登记 web，请求却是未登记的 db
	allowList := testAllowList(t, "web")
	handler := NewHandler(func(*http.Request) *config.AllowList { return allowList }, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	recorder := httptest.NewRecorder()
	handler.ServeJSON(recorder, httptest.NewRequest(http.MethodGet, StatusJSONPath, nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码应为 200，实得 %d", recorder.Code)
	}
	var body BatchResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if !body.Ok || len(body.Results) != 1 {
		t.Fatalf("只应返回已登记的一个容器，实得 %+v", body)
	}
	if body.Results[0].Container != "web" {
		t.Fatalf("结果应只含已登记容器，实得 %q", body.Results[0].Container)
	}
	if got := transport.countPrefix("/containers/db"); got != 0 {
		t.Fatalf("未登记容器不得发起任何 Docker 请求，实际 %d 次", got)
	}
}

func TestAuthorizeLookupRequiresRegisteredPair(t *testing.T) {
	allowList := testAllowList(t, "web")

	if _, ok := AuthorizeLookup(allowList, "local", "web"); !ok {
		t.Fatal("已登记容器应通过授权")
	}
	if _, ok := AuthorizeLookup(allowList, "local", "db"); ok {
		t.Fatal("未登记容器不得通过授权")
	}
	if _, ok := AuthorizeLookup(allowList, "unknown", "web"); ok {
		t.Fatal("未声明端点不得通过授权")
	}
	if _, ok := AuthorizeLookup(allowList, "  ", "web"); ok {
		t.Fatal("空服务名不得通过授权")
	}
	if _, ok := AuthorizeLookup(nil, "local", "web"); ok {
		t.Fatal("空允许列表不得通过授权")
	}
}

func TestServeStreamSendsFirstResultBeforeOthersFinish(t *testing.T) {
	// 慢容器阻塞在传输层，快容器先就绪
	slowRelease := make(chan struct{})
	transport := &fakeTransport{handler: func(ctx context.Context, path string) (Response, error) {
		if strings.Contains(path, "/slow/") {
			select {
			case <-slowRelease:
			case <-ctx.Done():
				return Response{}, ctx.Err()
			}
			return Response{StatusCode: 200, Body: inspectBody("running", true, 1)}, nil
		}
		return Response{StatusCode: 200, Body: inspectBody("stopped", false, 0)}, nil
	}}

	allowList := testAllowList(t, "fast", "slow")
	service := NewService(ListTargets(allowList), Options{
		Cache:       NewCache(),
		Transport:   transport,
		Concurrency: 2,
		Samples:     NewCpuSampleStore(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	items := service.Stream(ctx)

	select {
	case item := <-items:
		if item.Container != "fast" {
			t.Fatalf("首个结果应为 fast，实得 %q", item.Container)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("首个结果未在期限内送出，流式已退化为批量")
	}

	// 慢容器仍未放行，说明通道未等待全部完成
	close(slowRelease)
	if item := <-items; item.Container != "slow" {
		t.Fatalf("第二个结果应为 slow，实得 %q", item.Container)
	}
}

func TestServeStreamCancelsWithoutLeaking(t *testing.T) {
	transport := &fakeTransport{handler: func(ctx context.Context, _ string) (Response, error) {
		<-ctx.Done()
		return Response{}, ctx.Err()
	}}
	allowList := testAllowList(t, "a", "b", "c")
	service := NewService(ListTargets(allowList), Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	items := service.Stream(ctx)
	cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for range items {
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("取消后通道未及时关闭，存在 goroutine 泄漏")
	}
}

func TestHandlerStreamHeadersAndLines(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	allowList := testAllowList(t, "web")
	handler := NewHandler(func(*http.Request) *config.AllowList { return allowList }, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	server := httptest.NewServer(http.HandlerFunc(handler.ServeStream))
	defer server.Close()

	resp, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if got := resp.Header.Get("Content-Type"); got != NDJSONContentType {
		t.Fatalf("Content-Type 应为 %q，实得 %q", NDJSONContentType, got)
	}
	if got := resp.Header.Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("X-Accel-Buffering 应为 no，实得 %q", got)
	}

	scanner := bufio.NewScanner(resp.Body)
	lines := 0
	for scanner.Scan() {
		var item Item
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			t.Fatalf("行 %d 不是合法 JSON：%v", lines, err)
		}
		if item.Server != "local" || item.Container != "web" {
			t.Fatalf("行内容不正确：%+v", item)
		}
		lines++
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("读取流失败：%v", err)
	}
	if lines != 1 {
		t.Fatalf("应输出 1 行，实得 %d", lines)
	}
}

func TestHandlerJSONRespectsStatsParam(t *testing.T) {
	transport := &fakeTransport{handler: func(_ context.Context, path string) (Response, error) {
		if strings.Contains(path, "/stats") {
			return Response{StatusCode: 200, Body: statsBody(1000, 5000, 128, 256)}, nil
		}
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	allowList := testAllowList(t, "web")
	handler := NewHandler(func(*http.Request) *config.AllowList { return allowList }, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	// stats=0：只 inspect，不拉资源
	recorder := httptest.NewRecorder()
	handler.ServeJSON(recorder, httptest.NewRequest(http.MethodGet, StatusJSONPath+"?stats=0", nil))
	if got := transport.countPrefix("/containers/web/stats"); got != 0 {
		t.Fatalf("stats=0 时不得拉取 stats，实际 %d 次", got)
	}
	var lite BatchResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &lite); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if lite.Results[0].Result.Status != domain.DockerStatusRunning {
		t.Fatalf("应返回运行中，实得 %q", lite.Results[0].Result.Status)
	}

	// 默认含资源
	recorder = httptest.NewRecorder()
	handler.ServeJSON(recorder, httptest.NewRequest(http.MethodGet, StatusJSONPath, nil))
	if got := transport.countPrefix("/containers/web/stats"); got == 0 {
		t.Fatal("默认应拉取 stats")
	}
}

func TestHandlerServeHTTPDispatchesKnownPaths(t *testing.T) {
	transport := &fakeTransport{handler: func(_ context.Context, path string) (Response, error) {
		if strings.HasPrefix(path, "/containers/json") {
			return Response{StatusCode: 200, Body: []byte("[]")}, nil
		}
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	allowList := testAllowList(t, "web")
	handler := NewHandler(func(*http.Request) *config.AllowList { return allowList }, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	server := httptest.NewServer(handler)
	defer server.Close()

	cases := []struct {
		path        string
		accept      string
		contentType string
	}{
		// 默认数组：前端 fetchDockerBatch 只发 Accept: application/json
		{path: StatusPath, accept: "application/json", contentType: JSONContentType},
		// 显式声明才流式
		{path: StatusPath, accept: NDJSONContentType, contentType: NDJSONContentType},
		{path: StatusPath + "?stats=0", accept: NDJSONContentType, contentType: NDJSONContentType},
		{path: StatusJSONPath, accept: NDJSONContentType, contentType: JSONContentType},
	}
	for _, testCase := range cases {
		request, err := http.NewRequest(http.MethodGet, server.URL+testCase.path, nil)
		if err != nil {
			t.Fatalf("构造请求失败：%v", err)
		}
		request.Header.Set("Accept", testCase.accept)
		resp, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("请求 %s 失败：%v", testCase.path, err)
		}
		if got := resp.Header.Get("Content-Type"); got != testCase.contentType {
			t.Errorf("%s（Accept %q）的 Content-Type 应为 %q，实得 %q",
				testCase.path, testCase.accept, testCase.contentType, got)
		}
		_ = resp.Body.Close()
	}

	// 未登记容器是 403 且不发起 Docker 请求
	before := transport.count()
	resp, err := http.Get(server.URL + "/api/docker/local/db")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("未登记容器的状态码应为 403，实得 %d", resp.StatusCode)
	}
	if after := transport.count(); after != before {
		t.Fatalf("未登记容器不得发起 Docker 请求，实际新增 %d 次", after-before)
	}

	// 多段路径按契约返回 JSON 404，不回退成 HTML
	resp, err = http.Get(server.URL + "/api/docker/local/web/extra")
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("未实现路径的状态码应为 404，实得 %d", resp.StatusCode)
	}
	var envelope domain.ErrorEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		t.Fatalf("404 响应不是合法 JSON：%v", err)
	}
	if envelope.Ok {
		t.Fatal("404 信封的 ok 必须为 false")
	}
}

func TestListTargetsSkipsUndeclaredEndpoints(t *testing.T) {
	allowList := config.NewAllowList()
	allowList.DockerEndpoints["local"] = testEndpoint(t)
	allowList.DockerContainers[config.DockerContainerKey("local", "web")] = struct{}{}
	// 端点未声明的登记键应被丢弃
	allowList.DockerContainers[config.DockerContainerKey("ghost", "db")] = struct{}{}

	targets := ListTargets(allowList)
	if len(targets) != 1 || targets[0].Server != "local" || targets[0].Container != "web" {
		t.Fatalf("只应保留已声明端点的容器，实得 %+v", targets)
	}
	if targets := ListTargets(nil); len(targets) != 0 {
		t.Fatalf("空允许列表不得产生目标，实得 %+v", targets)
	}
}

func TestServiceStreamConcurrencyLimit(t *testing.T) {
	var (
		mu      sync.Mutex
		current int
		peak    int
	)
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		mu.Lock()
		current++
		if current > peak {
			peak = current
		}
		mu.Unlock()

		time.Sleep(20 * time.Millisecond)

		mu.Lock()
		current--
		mu.Unlock()
		return Response{StatusCode: 200, Body: inspectBody("running", true, 1)}, nil
	}}

	names := []string{"c1", "c2", "c3", "c4", "c5", "c6"}
	allowList := testAllowList(t, names...)
	service := NewService(ListTargets(allowList), Options{
		Cache:       NewCache(),
		Transport:   transport,
		Concurrency: 2,
		Samples:     NewCpuSampleStore(),
	})

	if items := service.Collect(context.Background()); len(items) != len(names) {
		t.Fatalf("应返回 %d 条，实得 %d", len(names), len(items))
	}

	mu.Lock()
	defer mu.Unlock()
	if peak > 2 {
		t.Fatalf("并发上限为 2，实际峰值 %d", peak)
	}
}
