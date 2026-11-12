package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
)

// 构造列表报文：一个运行中带健康、一个已停止、一个缺名称的坏条目。
func listBody() []byte {
	return []byte(`[` +
		`{"Id":"aaaaaaaaaaaaaaaaaaaa","Names":["/web"],"Image":"nginx:1.25",` +
		`"State":"running","Status":"Up 3 hours (healthy)",` +
		`"Ports":[{"PrivatePort":80,"PublicPort":8080,"Type":"tcp"},{"PrivatePort":443,"Type":"tcp"}]},` +
		`{"Id":"bbbbbbbbbbbbbbbbbbbb","Names":["/db"],"Image":"postgres:16",` +
		`"State":"exited","Status":"Exited (0) 2 hours ago","Ports":[]},` +
		`{"Id":"cccccccccccccccccccc","State":"paused"}` +
		`]`)
}

// 列表映射：健康状态、端口形态、缺名称退回 ID 前缀、结果按名称排序。
func TestMapListPayloadMapsSummaries(t *testing.T) {
	var payload any
	if err := json.Unmarshal(listBody(), &payload); err != nil {
		t.Fatalf("解析报文失败：%v", err)
	}

	summaries := mapListPayload(payload)
	if len(summaries) != 3 {
		t.Fatalf("应映射 3 条摘要，实得 %d", len(summaries))
	}

	byName := make(map[string]domain.DockerContainerSummary, len(summaries))
	names := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		byName[summary.Name] = summary
		names = append(names, summary.Name)
	}
	// 排序：ID 前缀（数字串）在前，其次 db、web
	for index := 1; index < len(names); index++ {
		if names[index-1] > names[index] {
			t.Fatalf("结果必须按名称升序，实得 %v", names)
		}
	}

	web, ok := byName["web"]
	if !ok {
		t.Fatalf("应保留具名条目，实得 %v", names)
	}
	if web.State != domain.DockerStatusRunning {
		t.Fatalf("运行态映射错误：%q", web.State)
	}
	if web.Health == nil || *web.Health != domain.DockerHealthHealthy {
		t.Fatalf("应识别健康状态：%+v", web.Health)
	}
	if web.Image == nil || *web.Image != "nginx:1.25" {
		t.Fatalf("镜像未保留：%+v", web.Image)
	}
	if len(web.Ports) != 2 || web.Ports[0] != "8080:80/tcp" || web.Ports[1] != "443/tcp" {
		t.Fatalf("端口形态不符：%v", web.Ports)
	}

	db := byName["db"]
	if db.State != domain.DockerStatusStopped {
		t.Fatalf("停止态映射错误：%q", db.State)
	}
	if db.Health != nil {
		t.Fatalf("无健康标注时不得输出 health：%v", *db.Health)
	}
	if db.Ports != nil {
		t.Fatalf("空端口列表不得输出 ports：%v", db.Ports)
	}
}

// 列表路径只走只读白名单里的 /containers/json?all=true。
func TestListUsesAllContainersPath(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: listBody()}, nil
	}}
	client := NewClient(testEndpoint(t), ClientOptions{
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	if _, err := client.List(context.Background()); err != nil {
		t.Fatalf("列表查询失败：%v", err)
	}
	paths := transport.paths()
	if len(paths) != 1 || paths[0] != "/containers/json?all=true" {
		t.Fatalf("列表请求路径不符：%v", paths)
	}
}

// 非 2xx 与非法 JSON 都返回可判定错误，供路由映射成出站失败。
func TestListFailureKinds(t *testing.T) {
	cases := []struct {
		name string
		resp Response
		kind ErrorKind
	}{
		{name: "服务端错误", resp: Response{StatusCode: 500, Body: []byte("boom")}, kind: KindOther},
		{name: "非法 JSON", resp: Response{StatusCode: 200, Body: []byte("{")}, kind: KindInvalid},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := NewClient(testEndpoint(t), ClientOptions{
				Transport: &fakeTransport{handler: func(context.Context, string) (Response, error) {
					return testCase.resp, nil
				}},
				Samples: NewCpuSampleStore(),
			})
			_, err := client.List(context.Background())
			var dockerErr *Error
			if err == nil || !asErrorKind(err, &dockerErr, testCase.kind) {
				t.Fatalf("应返回 %v，实得 %v", testCase.kind, err)
			}
		})
	}
}

// 列表端点：已声明端点正常返回容器数组，未声明端点 403 且 0 次请求。
func TestHandlerServeContainers(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: listBody()}, nil
	}}
	allowList := testAllowList(t, "web")
	handler := NewHandler(func(*http.Request) *config.AllowList { return allowList }, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/docker/local/containers", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d：%s", recorder.Code, recorder.Body.String())
	}

	var body domain.DockerContainersResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if !body.Ok || body.Server != "local" || len(body.Containers) != 3 {
		t.Fatalf("响应内容不符：%+v", body)
	}

	// 未声明端点：403 且不发起任何 Docker 请求
	before := transport.count()
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/docker/ghost/containers", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("未声明端点状态码 = %d，期望 403", recorder.Code)
	}
	if after := transport.count(); after != before {
		t.Fatalf("未声明端点不得发起 Docker 请求，实际新增 %d 次", after-before)
	}
}

// 单容器端点：已登记容器返回状态，未登记容器 403 且 0 次请求。
func TestHandlerServeContainer(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: inspectBody("running", true, 42)}, nil
	}}
	allowList := testAllowList(t, "web")
	handler := NewHandler(func(*http.Request) *config.AllowList { return allowList }, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/docker/local/web", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d：%s", recorder.Code, recorder.Body.String())
	}
	var status domain.DockerStatusResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &status); err != nil {
		t.Fatalf("响应不是合法 JSON：%v", err)
	}
	if status.Status != domain.DockerStatusRunning {
		t.Fatalf("状态应为 running，实得 %q", status.Status)
	}

	before := transport.count()
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/docker/local/db", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("未登记容器状态码 = %d，期望 403", recorder.Code)
	}
	if after := transport.count(); after != before {
		t.Fatalf("未登记容器不得发起 Docker 请求，实际新增 %d 次", after-before)
	}
}

// 名称里含转义字符时按解码后的值授权，解码失败按未登记处理。
func TestHandlerServeContainerDecodesSegment(t *testing.T) {
	transport := &fakeTransport{handler: func(context.Context, string) (Response, error) {
		return Response{StatusCode: 200, Body: inspectBody("running", true, 1)}, nil
	}}
	allowList := config.NewAllowList()
	allowList.DockerEndpoints["local"] = testEndpoint(t)
	allowList.DockerContainers[config.DockerContainerKey("local", "my web")] = struct{}{}
	handler := NewHandler(func(*http.Request) *config.AllowList { return allowList }, Options{
		Cache:     NewCache(),
		Transport: transport,
		Samples:   NewCpuSampleStore(),
	})

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/docker/local/my%20web", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("解码后应命中登记项，实得 %d：%s", recorder.Code, recorder.Body.String())
	}

	// 非法转义无法经 URL 解析构造，直接拼一个原始路径的请求
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, &http.Request{
		Method: http.MethodGet,
		URL:    &url.URL{Path: "/api/docker/local/%zz"},
	})
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("非法转义应按未登记处理，实得 %d", recorder.Code)
	}
}

// Accept 协商：只有显式声明应用/x-ndjson 才流式，q=0 视为拒绝。
func TestAcceptsNDJSON(t *testing.T) {
	cases := map[string]bool{
		"":                                       false,
		"application/json":                       false,
		"application/x-ndjson":                   true,
		"application/json, application/x-ndjson": true,
		"application/x-ndjson;q=0.9":             true,
		"application/x-ndjson;q=0":               false,
		"*/*":                                    false,
		"text/plain":                             false,
	}
	for header, expected := range cases {
		if got := acceptsNDJSON(header); got != expected {
			t.Errorf("acceptsNDJSON(%q) = %v，期望 %v", header, got, expected)
		}
	}
}

// 列表失败映射：超时 504、不可达 502。
func TestWriteListFailureMapsKinds(t *testing.T) {
	cases := []struct {
		kind   ErrorKind
		status int
	}{
		{kind: KindTimeout, status: http.StatusGatewayTimeout},
		{kind: KindUnreachable, status: http.StatusBadGateway},
		{kind: KindInvalid, status: http.StatusBadGateway},
	}
	for _, testCase := range cases {
		recorder := httptest.NewRecorder()
		writeListFailure(recorder, &Error{Kind: testCase.kind, Message: "失败"})
		if recorder.Code != testCase.status {
			t.Errorf("%v 应映射为 %d，实得 %d", testCase.kind, testCase.status, recorder.Code)
		}
		var envelope domain.ErrorEnvelope
		if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("响应不是合法 JSON：%v", err)
		}
		if envelope.Ok {
			t.Error("错误信封的 ok 必须为 false")
		}
	}
}

// 错误类型判定小工具，避免测试里散落 errors.As。
func asErrorKind(err error, target **Error, kind ErrorKind) bool {
	dockerErr, ok := err.(*Error)
	if !ok {
		return false
	}
	*target = dockerErr
	return dockerErr.Kind == kind
}
