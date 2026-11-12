package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/docker"
	"github.com/gatecross/homepage/api/internal/httpapi"
)

// 写入五份最小配置；docker 端点指向必然拒绝连接的本机端口，用来模拟无 Docker 环境。
func writeConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		config.FileSettings: "title: 组装测试\nuseEqualHeights: true\n",
		config.FileServices: "- 服务:\n" +
			"    - name: 面板\n" +
			"      href: https://example.com\n" +
			"    - name: 状态\n" +
			"      href: http://127.0.0.1:8080\n" +
			"      server: local\n" +
			"      container: web\n",
		config.FileBookmarks: "- 常用:\n    - name: 文档\n      href: https://example.com/docs\n",
		config.FileWidgets:   "[]\n",
		config.FileDocker:    "local: tcp://127.0.0.1:1\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("写入 %s 失败：%v", name, err)
		}
	}
	return dir
}

// 按入口装配的路由，每个端点都能真实响应。
func newAssembledRouter(t *testing.T) http.Handler {
	t.Helper()
	store := config.NewStore()
	if err := store.Load(writeConfigDir(t)); err != nil {
		t.Fatalf("加载配置失败：%v", err)
	}
	allowList := func(*http.Request) *config.AllowList {
		return store.Snapshot().AllowList
	}
	return httpapi.NewRouter(httpapi.Options{
		Mounts: httpapi.Mounts{
			Config: config.NewHandler(store),
			Docker: docker.NewHandler(allowList, docker.Options{}),
		},
	})
}

func get(t *testing.T, server *httptest.Server, path string) (*http.Response, []byte) {
	t.Helper()
	response, err := http.Get(server.URL + path)
	if err != nil {
		t.Fatalf("请求 %s 失败：%v", path, err)
	}
	defer func() { _ = response.Body.Close() }()
	body := make([]byte, 0, 4096)
	buffer := make([]byte, 4096)
	for {
		read, err := response.Body.Read(buffer)
		body = append(body, buffer[:read]...)
		if err != nil {
			break
		}
	}
	return response, body
}

// 健康检查与版本端点必须可用。
func TestAssembledHealthAndVersion(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	response, body := get(t, server, "/api/health")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("健康检查状态码 = %d，期望 200", response.StatusCode)
	}
	var health struct {
		Ok      bool   `json:"ok"`
		Service string `json:"service"`
	}
	if err := json.Unmarshal(body, &health); err != nil {
		t.Fatalf("健康检查响应不是合法 JSON：%v", err)
	}
	if !health.Ok || health.Service == "" {
		t.Fatalf("健康检查内容不完整：%+v", health)
	}

	// check=0 只回本地版本，不依赖网络
	response, body = get(t, server, "/api/version?check=0")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("版本端点状态码 = %d，期望 200", response.StatusCode)
	}
	var version struct {
		Ok      bool   `json:"ok"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &version); err != nil || !version.Ok || version.Version == "" {
		t.Fatalf("版本端点内容不符：%s", body)
	}
}

// 配置端点返回规范化配置，且不下发 Docker 连接串。
func TestAssembledConfigEndpoints(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	response, body := get(t, server, "/api/config")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("/api/config 状态码 = %d，期望 200", response.StatusCode)
	}
	var normalized struct {
		Settings struct {
			Title string `json:"title"`
		} `json:"settings"`
		Services []any `json:"services"`
	}
	if err := json.Unmarshal(body, &normalized); err != nil {
		t.Fatalf("/api/config 响应不是合法 JSON：%v", err)
	}
	if normalized.Settings.Title != "组装测试" {
		t.Fatalf("标题 = %q，期望「组装测试」", normalized.Settings.Title)
	}
	if strings.Contains(string(body), "127.0.0.1:1") {
		t.Fatalf("配置响应不得下发 Docker 连接串：%s", body)
	}

	response, _ = get(t, server, "/api/config/editable")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("/api/config/editable 状态码 = %d，期望 200", response.StatusCode)
	}
}

// 无 Docker 环境：默认数组端点与显式流式端点都返回 unavailable，且不 panic。
func TestAssembledDockerUnavailableWithoutEngine(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	// 默认走数组，前端 fetchDockerBatch 无需改动
	response, body := get(t, server, docker.StatusPath)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("数组端点状态码 = %d，期望 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != docker.JSONContentType {
		t.Fatalf("默认 Content-Type = %q，期望 JSON", got)
	}
	var batch docker.BatchResponse
	if err := json.Unmarshal(body, &batch); err != nil {
		t.Fatalf("默认响应不是合法 JSON：%v", err)
	}
	if !batch.Ok || len(batch.Results) != 1 {
		t.Fatalf("默认响应内容不符：%+v", batch)
	}
	if batch.Results[0].Result.Status != "unavailable" {
		t.Fatalf("无 Docker 时状态应为 unavailable，实得 %q", batch.Results[0].Result.Status)
	}

	// 显式要求应用/x-ndjson 才走流式
	request, err := http.NewRequest(http.MethodGet, server.URL+docker.StatusPath, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	request.Header.Set("Accept", docker.NDJSONContentType)
	streamResponse, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("流式请求失败：%v", err)
	}
	defer func() { _ = streamResponse.Body.Close() }()
	if got := streamResponse.Header.Get("Content-Type"); got != docker.NDJSONContentType {
		t.Fatalf("流式端点 Content-Type = %q", got)
	}

	var streamed bytes.Buffer
	if _, err := streamed.ReadFrom(streamResponse.Body); err != nil {
		t.Fatalf("读取流失败：%v", err)
	}
	lines := 0
	for _, line := range strings.Split(streamed.String(), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines++
		var item docker.Item
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			t.Fatalf("第 %d 行结构不符：%v", lines, err)
		}
		if item.Result.Status != "unavailable" {
			t.Fatalf("无 Docker 时状态应为 unavailable，实得 %q", item.Result.Status)
		}
	}
	if lines != 1 {
		t.Fatalf("应输出 1 行，实得 %d", lines)
	}

	// status.json 始终是数组
	response, body = get(t, server, docker.StatusJSONPath)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status.json 状态码 = %d，期望 200", response.StatusCode)
	}
	if err := json.Unmarshal(body, &batch); err != nil {
		t.Fatalf("status.json 响应不是合法 JSON：%v", err)
	}
	if !batch.Ok || len(batch.Results) != 1 {
		t.Fatalf("status.json 内容不符：%+v", batch)
	}
}

// 批量路径不会被单容器通配段吞掉：/api/docker/status 仍是数组。
func TestAssembledDockerStatusNotShadowed(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	response, body := get(t, server, docker.StatusPath)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != docker.JSONContentType {
		t.Fatalf("Content-Type = %q，期望 JSON 数组", got)
	}
	var batch docker.BatchResponse
	if err := json.Unmarshal(body, &batch); err != nil {
		t.Fatalf("响应不是批量的数组契约：%v", err)
	}
}

// 已注册容器的单容器端点走真实查询，无 Docker 时降级为 unavailable。
func TestAssembledDockerSingleContainer(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	response, body := get(t, server, "/api/docker/local/web")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("单容器状态码 = %d，期望 200", response.StatusCode)
	}
	var status dockerStatusBody
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("单容器响应不是合法 JSON：%v", err)
	}
	if status.Status != "unavailable" {
		t.Fatalf("无 Docker 时状态应为 unavailable，实得 %q", status.Status)
	}
}

// 未登记容器与未声明端点都是 403 信封，且不发起任何 Docker 请求。
func TestAssembledDockerLookupForbidden(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	for _, path := range []string{
		"/api/docker/local/db",
		"/api/docker/unknown/web",
		"/api/docker/ghost/containers",
	} {
		response, body := get(t, server, path)
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("%s 状态码 = %d，期望 403", path, response.StatusCode)
		}
		if got := response.Header.Get("Content-Type"); got != httpapi.JSONContentType {
			t.Fatalf("%s Content-Type = %q，期望 JSON", path, got)
		}
		var envelope struct {
			Ok    bool `json:"ok"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatalf("%s 响应不是合法 JSON：%v", path, err)
		}
		if envelope.Ok || envelope.Error.Code != httpapi.CodeForbidden {
			t.Fatalf("%s 信封不符：%s", path, body)
		}
	}
}

// 已声明端点的容器列表连通失败映射为出站失败，而非 500。
func TestAssembledDockerListFailure(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	response, body := get(t, server, "/api/docker/local/containers")
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("列表失败状态码 = %d，期望 502：%s", response.StatusCode, body)
	}
	var envelope struct {
		Ok    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("列表失败响应不是合法 JSON：%v", err)
	}
	if envelope.Ok || envelope.Error.Code != httpapi.CodeExternal {
		t.Fatalf("列表失败信封不符：%s", body)
	}
}

// 数据端点未挂载时返回 JSON 404，不会回退到 SPA。
func TestAssembledDataEndpointsUnmounted(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	for _, path := range []string{"/api/probe/prb_x", "/api/widgets/wgt_x", "/api/info/inf_x"} {
		response, body := get(t, server, path)
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404", path, response.StatusCode)
		}
		if got := response.Header.Get("Content-Type"); got != httpapi.JSONContentType {
			t.Fatalf("%s Content-Type = %q，期望 JSON", path, got)
		}
		if !strings.Contains(string(body), `"ok":false`) {
			t.Fatalf("%s 应返回失败信封：%s", path, body)
		}
	}
}

// 未实现的 API 路径是 JSON 404，不会被 SPA 吞掉。
func TestAssembledUnknownAPIPathIsJSON(t *testing.T) {
	server := httptest.NewServer(newAssembledRouter(t))
	defer server.Close()

	for _, path := range []string{"/api/not-implemented", "/api/docker/too/many/segments"} {
		response, body := get(t, server, path)
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404", path, response.StatusCode)
		}
		if got := response.Header.Get("Content-Type"); got != httpapi.JSONContentType {
			t.Fatalf("%s Content-Type = %q，期望 JSON", path, got)
		}
		var envelope struct {
			Ok bool `json:"ok"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatalf("%s 响应不是合法 JSON：%v", path, err)
		}
		if envelope.Ok {
			t.Fatalf("%s 错误信封的 ok 必须为 false", path)
		}
	}
}

// 单容器响应体的测试视图，字段名与契约一致。
type dockerStatusBody struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}
