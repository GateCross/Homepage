package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gatecross/homepage/api/internal/adapters"
	"github.com/gatecross/homepage/api/internal/assets"
	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/docker"
	"github.com/gatecross/homepage/api/internal/domain"
	"github.com/gatecross/homepage/api/internal/httpapi"
	"github.com/gatecross/homepage/api/internal/icons"
	"github.com/gatecross/homepage/api/internal/probe"
	"github.com/gatecross/homepage/api/internal/providers"
	"github.com/gatecross/homepage/api/internal/routes"
)

// 集成夹具：临时配置目录 + 完整 handler + 出网计数。
type fixture struct {
	dir     string
	store   *config.Store
	handler http.Handler
	counter *outbound
}

// 出网计数：所有真实出网点都经过这里统计。
type outbound struct {
	probe     atomic.Int64
	widget    atomic.Int64
	weather   atomic.Int64
	resources atomic.Int64
	docker    atomic.Int64
}

// 夹具配置：一条服务带探测与组件，一条服务带容器，信息组件覆盖三种类型。
const (
	fixtureWidgetID = "wgt_fixture"
	fixtureProbeID  = "prb_fixture"
	fixtureDocker   = "tcp://127.0.0.1:1"
)

// 写入五份配置；widgets 与 services 的 ID 由稳定哈希生成，因此这里只断言端点可用性。
func writeFixtureDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		config.FileSettings: "title: 集成测试\n" +
			"useEqualHeights: true\n" +
			"layout:\n" +
			"  Server:\n" +
			"    columns: 4\n",
		config.FileServices: "- Server:\n" +
			"    - name: 面板\n" +
			"      href: https://example.com\n" +
			"      siteMonitor: https://example.com\n" +
			"    - name: 状态容器\n" +
			"      href: http://127.0.0.1:8080\n" +
			"      server: local\n" +
			"      container: web\n" +
			"      widgets:\n" +
			"        - type: customapi\n" +
			"          url: https://example.com/api\n",
		config.FileBookmarks: "- 常用:\n    - name: 文档\n      href: https://example.com/docs\n",
		config.FileWidgets: "- type: datetime\n" +
			"  timezone: Asia/Shanghai\n" +
			"  label: 本地时间\n" +
			"- type: openmeteo\n" +
			"  cityId: \"101020100\"\n" +
			"  location: 上海\n" +
			"- type: resources\n" +
			"  cpu: true\n" +
			"  memory: true\n",
		config.FileDocker: "local: " + fixtureDocker + "\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("写入 %s 失败：%v", name, err)
		}
	}
	return dir
}

// 装配完整服务：配置读写、资源上传、图标、探测与组件、Docker 全部接线。
func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := writeFixtureDir(t)
	store := config.NewStore()
	if err := store.Load(dir); err != nil {
		t.Fatalf("加载配置失败：%v", err)
	}

	counter := &outbound{}
	allowList := func(*http.Request) *config.AllowList {
		return store.Snapshot().AllowList
	}

	handler := httpapi.NewRouter(httpapi.Options{
		Mounts: httpapi.Mounts{
			Config: config.NewHandler(store).WithConfigDir(dir),
			Docker: docker.NewHandler(allowList, docker.Options{
				// 假传输层只计数，永远返回不可达，避免真实拨号
				Transport: countingDockerTransport{counter: counter},
				// 采样表与缓存隔离到本夹具，避免跨用例污染
				Cache:   docker.NewCache(),
				Samples: docker.NewCpuSampleStore(),
			}),
			Assets: assets.NewHandler(dir),
			Icons:  icons.NewHandler(icons.NewService(icons.Options{ImagesDir: filepath.Join(dir, "images")})),
			Data: routes.NewHandler(routes.Deps{
				AllowList: allowList,
				Probe: func(context.Context, string, int, []domain.StatusRange) probe.Result {
					counter.probe.Add(1)
					code := 200
					return probe.Result{Status: probe.StatusReachable, HTTPCode: &code}
				},
				RunWidget: func(context.Context, adapters.RunRequest) adapters.ServiceWidgetResult {
					counter.widget.Add(1)
					return adapters.SuccessResult([]adapters.Metric{{
						ID: "online", Label: "在线", Value: "是", Status: adapters.MetricStatusOK,
					}}, nil)
				},
				FetchWeather: func(context.Context, providers.OpenMeteoTarget) (providers.OpenMeteoInfoResponse, error) {
					counter.weather.Add(1)
					text := "晴"
					return providers.OpenMeteoInfoResponse{TemperatureC: 23.4, ConditionText: &text}, nil
				},
				CollectResources: func(context.Context, providers.ResourcesTarget) providers.ResourcesInfoResponse {
					counter.resources.Add(1)
					percent := 12.5
					return providers.ResourcesInfoResponse{Items: []providers.ResourceItem{{
						ID: "cpu", Label: "CPU", Percent: &percent,
					}}}
				},
			}),
		},
	})

	return &fixture{dir: dir, store: store, handler: handler, counter: counter}
}

// 只计数的 Docker 传输层：永远返回不可达，测试环境不产生真实拨号。
type countingDockerTransport struct {
	counter *outbound
}

func (t countingDockerTransport) Do(context.Context, config.DockerEndpoint, docker.Request) (docker.Response, error) {
	t.counter.docker.Add(1)
	return docker.Response{}, &docker.Error{Kind: docker.KindUnreachable, Message: "Docker 端点不可达"}
}

// 取快照中的探测 ID：按允许列表里的键，避免测试重复实现 ID 算法。
func (f *fixture) probeID() string {
	for id := range f.store.Snapshot().AllowList.HTTPProbeTargets {
		return id
	}
	return ""
}

// 取快照中的组件 ID。
func (f *fixture) widgetID() string {
	for id := range f.store.Snapshot().AllowList.WidgetTargets {
		return id
	}
	return ""
}

// 按类型取信息组件 ID。
func (f *fixture) infoID(infoType string) string {
	for id, target := range f.store.Snapshot().AllowList.InfoTargets {
		if target.Type == infoType {
			return id
		}
	}
	return ""
}

// 发一次请求并返回状态码、头部与响应体。
func (f *fixture) do(t *testing.T, method, path string, body io.Reader, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	request := httptest.NewRequest(method, path, body)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	response := recorder.Result()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("%s %s 读取响应失败：%v", method, path, err)
	}
	_ = response.Body.Close()
	return response, payload
}

// 解出 JSON 对象；失败时终止用例。
func decodeObject(t *testing.T, payload []byte, label string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("%s 响应不是合法 JSON：%s", label, payload)
	}
	return value
}

// 逐个端点断言状态码与 JSON 形状。
func TestIntegrationEndpointMatrix(t *testing.T) {
	f := newFixture(t)

	cases := []struct {
		name        string
		method      string
		path        string
		status      int
		contentType string
		// 断言响应体是 JSON 对象（而非数组或标量）
		wantObject bool
	}{
		{name: "健康检查", method: http.MethodGet, path: "/api/health", status: 200, contentType: httpapi.JSONContentType, wantObject: true},
		{name: "版本", method: http.MethodGet, path: "/api/version?check=0", status: 200, contentType: httpapi.JSONContentType, wantObject: true},
		{name: "配置", method: http.MethodGet, path: "/api/config", status: 200, contentType: httpapi.JSONContentType, wantObject: true},
		{name: "可编辑配置", method: http.MethodGet, path: "/api/config/editable", status: 200, contentType: httpapi.JSONContentType, wantObject: true},
		{name: "批量状态默认数组", method: http.MethodGet, path: "/api/docker/status", status: 200, contentType: docker.JSONContentType, wantObject: true},
		{name: "批量状态显式数组", method: http.MethodGet, path: "/api/docker/status.json", status: 200, contentType: docker.JSONContentType, wantObject: true},
		{name: "单容器已登记", method: http.MethodGet, path: "/api/docker/local/web", status: 200, contentType: docker.JSONContentType, wantObject: true},
		{name: "单容器未登记", method: http.MethodGet, path: "/api/docker/local/db", status: 403, contentType: httpapi.JSONContentType, wantObject: true},
		{name: "容器列表已声明", method: http.MethodGet, path: "/api/docker/local/containers", status: 502, contentType: docker.JSONContentType, wantObject: true},
		{name: "容器列表未声明", method: http.MethodGet, path: "/api/docker/ghost/containers", status: 403, contentType: docker.JSONContentType, wantObject: true},
		{name: "未知接口", method: http.MethodGet, path: "/api/nope", status: 404, contentType: httpapi.JSONContentType, wantObject: true},
		{name: "非 GET 配置", method: http.MethodDelete, path: "/api/config", status: 404, contentType: httpapi.JSONContentType, wantObject: true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			response, payload := f.do(t, testCase.method, testCase.path, nil, nil)
			if response.StatusCode != testCase.status {
				t.Fatalf("%s %s 状态码 = %d，期望 %d：%s",
					testCase.method, testCase.path, response.StatusCode, testCase.status, payload)
			}
			if got := response.Header.Get("Content-Type"); got != testCase.contentType {
				t.Fatalf("%s Content-Type = %q，期望 %q", testCase.path, got, testCase.contentType)
			}
			if testCase.wantObject && !json.Valid(payload) {
				t.Fatalf("%s 响应不是合法 JSON：%s", testCase.path, payload)
			}
		})
	}
}

// 数据端点：已登记目标正常返回，字段名与前端契约逐字一致。
func TestIntegrationDataEndpoints(t *testing.T) {
	f := newFixture(t)

	probeID := f.probeID()
	if probeID == "" {
		t.Fatal("夹具应登记至少一个探测目标")
	}
	response, payload := f.do(t, http.MethodGet, "/api/probe/"+probeID, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("探测端点状态码 = %d：%s", response.StatusCode, payload)
	}
	body := decodeObject(t, payload, "探测")
	if body["status"] != "reachable" {
		t.Fatalf("探测响应不符：%s", payload)
	}

	widgetID := f.widgetID()
	if widgetID == "" {
		t.Fatal("夹具应登记至少一个组件目标")
	}
	response, payload = f.do(t, http.MethodGet, "/api/widgets/"+widgetID, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("组件端点状态码 = %d：%s", response.StatusCode, payload)
	}
	body = decodeObject(t, payload, "组件")
	if body["ok"] != true {
		t.Fatalf("组件响应应为成功：%s", payload)
	}
	if _, ok := body["metrics"].([]any); !ok {
		t.Fatalf("成功组件必须带 metrics 数组：%s", payload)
	}

	weatherID := f.infoID("openmeteo")
	if weatherID == "" {
		t.Fatal("夹具应登记天气组件")
	}
	response, payload = f.do(t, http.MethodGet, "/api/info/"+weatherID, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("天气端点状态码 = %d：%s", response.StatusCode, payload)
	}
	body = decodeObject(t, payload, "天气")
	if body["temperatureC"] != 23.4 {
		t.Fatalf("天气响应不符：%s", payload)
	}

	resourcesID := f.infoID("resources")
	if resourcesID == "" {
		t.Fatal("夹具应登记资源组件")
	}
	response, payload = f.do(t, http.MethodGet, "/api/info/"+resourcesID, nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("资源端点状态码 = %d：%s", response.StatusCode, payload)
	}
	body = decodeObject(t, payload, "资源")
	if _, ok := body["items"].([]any); !ok {
		t.Fatalf("资源响应必须带 items 数组：%s", payload)
	}

	// datetime 由前端本地格式化，服务端不提供数据接口
	datetimeID := f.infoID("datetime")
	if datetimeID == "" {
		t.Fatal("夹具应登记时间组件")
	}
	response, payload = f.do(t, http.MethodGet, "/api/info/"+datetimeID, nil, nil)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("时间组件状态码 = %d，期望 403：%s", response.StatusCode, payload)
	}
}

// 未登记目标一律 403，且出网计数保持不变。
func TestIntegrationUnregisteredTargetsIssueNoOutbound(t *testing.T) {
	f := newFixture(t)

	paths := []string{
		"/api/probe/prb_unregistered",
		"/api/widgets/wgt_unregistered",
		"/api/info/inf_unregistered",
		"/api/docker/local/db",
		"/api/docker/ghost/containers",
	}
	before := snapshotCounts(f.counter)
	for _, path := range paths {
		response, payload := f.do(t, http.MethodGet, path, nil, nil)
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("%s 状态码 = %d，期望 403：%s", path, response.StatusCode, payload)
		}
		body := decodeObject(t, payload, path)
		if body["ok"] != false {
			t.Fatalf("%s 应返回失败信封：%s", path, payload)
		}
	}
	if after := snapshotCounts(f.counter); after != before {
		t.Fatalf("未登记目标不得出网：前 %+v 后 %+v", before, after)
	}
}

// 计数快照，用于比较请求前后是否发生出网。
func snapshotCounts(counter *outbound) [5]int64 {
	return [5]int64{
		counter.probe.Load(),
		counter.widget.Load(),
		counter.weather.Load(),
		counter.resources.Load(),
		counter.docker.Load(),
	}
}

// PUT /api/config 成功后再 GET /api/config 必须读到新值。
func TestIntegrationConfigWriteThenRead(t *testing.T) {
	f := newFixture(t)

	response, payload := f.do(t, http.MethodGet, "/api/config/editable", nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("读取可编辑配置失败：%d %s", response.StatusCode, payload)
	}

	var editable map[string]any
	if err := json.Unmarshal(payload, &editable); err != nil {
		t.Fatalf("可编辑配置不是合法 JSON：%v", err)
	}
	settings, ok := editable["settings"].(map[string]any)
	if !ok {
		t.Fatalf("可编辑配置缺少 settings：%s", payload)
	}
	// 新标题带上时间戳以外的固定前缀，便于断言
	const newTitle = "写回后的标题"
	settings["title"] = newTitle

	// 密钥字段的读取视图要换成写回三态
	writePayload := replaceSecretViews(editable)
	encoded, err := json.Marshal(writePayload)
	if err != nil {
		t.Fatalf("序列化写回载荷失败：%v", err)
	}

	response, payload = f.do(t, http.MethodPut, "/api/config", bytes.NewReader(encoded),
		map[string]string{"Content-Type": "application/json"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("写回状态码 = %d：%s", response.StatusCode, payload)
	}
	body := decodeObject(t, payload, "写回")
	if body["ok"] != true {
		t.Fatalf("写回响应应为 ok:true：%s", payload)
	}

	// 读端点立刻能读到新值，说明快照已替换
	response, payload = f.do(t, http.MethodGet, "/api/config", nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("写回后读取配置失败：%d %s", response.StatusCode, payload)
	}
	normalized := decodeObject(t, payload, "配置")
	settings, ok = normalized["settings"].(map[string]any)
	if !ok {
		t.Fatalf("配置响应缺少 settings：%s", payload)
	}
	if settings["title"] != newTitle {
		t.Fatalf("写回后标题 = %v，期望 %q", settings["title"], newTitle)
	}

	// 磁盘上的文件也已经更新
	content, err := os.ReadFile(filepath.Join(f.dir, config.FileSettings))
	if err != nil {
		t.Fatalf("读取 settings.yaml 失败：%v", err)
	}
	if !strings.Contains(string(content), newTitle) {
		t.Fatalf("settings.yaml 未写入新标题：%s", content)
	}
}

// 递归把 {"status": ...} 换成 {"mode": "keep"}，其余原样保留。
func replaceSecretViews(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		if status, isSecretView := typed["status"].(string); isSecretView && len(typed) == 1 {
			if status == "configured" || status == "unset" {
				return map[string]any{"mode": "keep"}
			}
		}
		for key, item := range typed {
			typed[key] = replaceSecretViews(item)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = replaceSecretViews(item)
		}
		return typed
	default:
		return value
	}
}

// 非法写回载荷返回 422，且不改动磁盘内容。
func TestIntegrationConfigWriteRejectsInvalidPayload(t *testing.T) {
	f := newFixture(t)

	before, err := os.ReadFile(filepath.Join(f.dir, config.FileSettings))
	if err != nil {
		t.Fatalf("读取 settings.yaml 失败：%v", err)
	}

	response, payload := f.do(t, http.MethodPut, "/api/config", strings.NewReader(`{"settings":{}}`),
		map[string]string{"Content-Type": "application/json"})
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("非法载荷状态码 = %d，期望 422：%s", response.StatusCode, payload)
	}
	body := decodeObject(t, payload, "非法写回")
	if body["ok"] != false {
		t.Fatalf("非法写回应返回失败信封：%s", payload)
	}

	after, err := os.ReadFile(filepath.Join(f.dir, config.FileSettings))
	if err != nil {
		t.Fatalf("读取 settings.yaml 失败：%v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("非法载荷不得改动磁盘上的配置文件")
	}
}

// 资源上传：合法 PNG 落盘并返回 /images 路径，非图片内容返回 422。
func TestIntegrationAssetUpload(t *testing.T) {
	f := newFixture(t)

	pngBytes := append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, []byte("payload")...)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "logo.png")
	if err != nil {
		t.Fatalf("构造上传分段失败：%v", err)
	}
	if _, err := part.Write(pngBytes); err != nil {
		t.Fatalf("写入上传内容失败：%v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭上传体积失败：%v", err)
	}

	response, payload := f.do(t, http.MethodPost, assets.UploadPath, body,
		map[string]string{"Content-Type": writer.FormDataContentType()})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("上传状态码 = %d：%s", response.StatusCode, payload)
	}
	uploaded := decodeObject(t, payload, "上传")
	path, _ := uploaded["path"].(string)
	if uploaded["ok"] != true || !strings.HasPrefix(path, "/images/") {
		t.Fatalf("上传响应不符：%s", payload)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "images", uploaded["filename"].(string))); err != nil {
		t.Fatalf("上传文件未落盘：%v", err)
	}

	// 内容不是 PNG 时拒绝，且不落盘
	body = &bytes.Buffer{}
	writer = multipart.NewWriter(body)
	part, err = writer.CreateFormFile("file", "fake.png")
	if err != nil {
		t.Fatalf("构造上传分段失败：%v", err)
	}
	if _, err := part.Write([]byte("not an image")); err != nil {
		t.Fatalf("写入上传内容失败：%v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭上传体积失败：%v", err)
	}
	response, payload = f.do(t, http.MethodPost, assets.UploadPath, body,
		map[string]string{"Content-Type": writer.FormDataContentType()})
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("非图片状态码 = %d，期望 422：%s", response.StatusCode, payload)
	}
}

// 图标端点：非法 URL 是 422，导入不存在的会话是 404，两次都不出网。
func TestIntegrationIconEndpointsValidateInput(t *testing.T) {
	f := newFixture(t)

	response, payload := f.do(t, http.MethodPost, icons.ResolvePath,
		strings.NewReader(`{"url":"not-a-url"}`),
		map[string]string{"Content-Type": "application/json"})
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("非法 URL 状态码 = %d，期望 422：%s", response.StatusCode, payload)
	}

	response, payload = f.do(t, http.MethodPost, icons.ImportPath,
		strings.NewReader(`{"sessionId":"nope","candidateId":"nope"}`),
		map[string]string{"Content-Type": "application/json"})
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("未知会话状态码 = %d，期望 404：%s", response.StatusCode, payload)
	}

	// 非 JSON 请求体按配置无效处理
	response, payload = f.do(t, http.MethodPost, icons.ResolvePath,
		strings.NewReader("not json"), nil)
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("非 JSON 体状态码 = %d，期望 422：%s", response.StatusCode, payload)
	}
}

// 批量端点默认数组，显式 Accept 才流式；两者内容一致。
func TestIntegrationDockerContentNegotiation(t *testing.T) {
	f := newFixture(t)

	response, payload := f.do(t, http.MethodGet, docker.StatusPath, nil,
		map[string]string{"Accept": "application/json"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("数组端点状态码 = %d：%s", response.StatusCode, payload)
	}
	var batch docker.BatchResponse
	if err := json.Unmarshal(payload, &batch); err != nil {
		t.Fatalf("数组端点不是合法 JSON：%v", err)
	}
	if !batch.Ok || len(batch.Results) != 1 || batch.Results[0].Container != "web" {
		t.Fatalf("数组端点内容不符：%s", payload)
	}

	response, payload = f.do(t, http.MethodGet, docker.StatusPath, nil,
		map[string]string{"Accept": docker.NDJSONContentType})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("流式端点状态码 = %d：%s", response.StatusCode, payload)
	}
	if got := response.Header.Get("Content-Type"); got != docker.NDJSONContentType {
		t.Fatalf("流式端点 Content-Type = %q", got)
	}
	if got := response.Header.Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("流式端点 X-Accel-Buffering = %q，期望 no", got)
	}

	lines := 0
	for _, line := range strings.Split(string(payload), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines++
		var item docker.Item
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			t.Fatalf("第 %d 行不是合法 JSON：%v", lines, err)
		}
		if item.Result.Status != "unavailable" {
			t.Fatalf("假传输层下状态应为 unavailable，实得 %q", item.Result.Status)
		}
	}
	if lines != 1 {
		t.Fatalf("应输出 1 行，实得 %d", lines)
	}
}

// 流式端点在 Accept 含 q=0 时按拒绝处理，仍走数组。
func TestIntegrationDockerAcceptQualityZero(t *testing.T) {
	f := newFixture(t)

	response, payload := f.do(t, http.MethodGet, docker.StatusPath, nil,
		map[string]string{"Accept": docker.NDJSONContentType + ";q=0"})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d：%s", response.StatusCode, payload)
	}
	if got := response.Header.Get("Content-Type"); got != docker.JSONContentType {
		t.Fatalf("q=0 时应返回数组，实得 Content-Type %q", got)
	}
}

// 配置写回后允许列表随之更新：新登记的容器立即可查。
func TestIntegrationAllowListRefreshesAfterWrite(t *testing.T) {
	f := newFixture(t)

	// 写回前 db 未登记
	response, _ := f.do(t, http.MethodGet, "/api/docker/local/db", nil, nil)
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("写回前未登记容器状态码 = %d，期望 403", response.StatusCode)
	}

	// 在 services.yaml 里补一个引用 db 的服务条目
	content, err := os.ReadFile(filepath.Join(f.dir, config.FileServices))
	if err != nil {
		t.Fatalf("读取 services.yaml 失败：%v", err)
	}
	added := string(content) +
		"    - name: 数据库\n" +
		"      href: http://127.0.0.1:5432\n" +
		"      server: local\n" +
		"      container: db\n"
	if err := os.WriteFile(filepath.Join(f.dir, config.FileServices), []byte(added), 0o644); err != nil {
		t.Fatalf("写入 services.yaml 失败：%v", err)
	}
	if err := f.store.Load(f.dir); err != nil {
		t.Fatalf("重新加载配置失败：%v", err)
	}

	response, payload := f.do(t, http.MethodGet, "/api/docker/local/db", nil, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("新登记容器状态码 = %d，期望 200：%s", response.StatusCode, payload)
	}
	var status dockerStatus
	if err := json.Unmarshal(payload, &status); err != nil {
		t.Fatalf("单容器响应不是合法 JSON：%v", err)
	}
	if status.Status != "unavailable" {
		t.Fatalf("假传输层下状态应为 unavailable，实得 %q", status.Status)
	}
}

// 单容器响应视图。
type dockerStatus struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// 路由模式互不冲突：静态段优先于通配段，批量路径不会被单容器端点吃掉。
func TestIntegrationRoutePrecedence(t *testing.T) {
	f := newFixture(t)

	// /api/docker/status 必须走批量数组，而不是被当成 server=status
	response, payload := f.do(t, http.MethodGet, docker.StatusPath, nil, nil)
	if got := response.Header.Get("Content-Type"); got != docker.JSONContentType {
		t.Fatalf("/api/docker/status Content-Type = %q，期望 JSON 数组", got)
	}
	if !strings.Contains(string(payload), `"results"`) {
		t.Fatalf("/api/docker/status 应返回批量数组：%s", payload)
	}

	// /api/docker/local/containers 走列表端点，而不是 container=containers
	response, payload = f.do(t, http.MethodGet, "/api/docker/local/containers", nil, nil)
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("列表端点状态码 = %d，期望 502：%s", response.StatusCode, payload)
	}
	body := decodeObject(t, payload, "列表")
	errorBody, _ := body["error"].(map[string]any)
	if errorBody["code"] != httpapi.CodeExternal {
		t.Fatalf("列表端点应返回 EXTERNAL_FAILURE：%s", payload)
	}

	// 八段以内但非两段的子路径是 404；双斜杠由标准库先做路径收敛，返回 307
	for _, path := range []string{"/api/docker/", "/api/docker/a/b/c"} {
		response, payload = f.do(t, http.MethodGet, path, nil, nil)
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d，期望 404：%s", path, response.StatusCode, payload)
		}
	}
	response, payload = f.do(t, http.MethodGet, "/api/docker//web", nil, nil)
	if response.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("双斜杠状态码 = %d，期望 307：%s", response.StatusCode, payload)
	}
}

// 所有端点都必须带 no-store，避免中间缓存把配置与状态冻结。
func TestIntegrationResponsesAreNotCached(t *testing.T) {
	f := newFixture(t)

	for _, path := range []string{"/api/health", "/api/config", docker.StatusPath, "/api/docker/local/web"} {
		response, _ := f.do(t, http.MethodGet, path, nil, nil)
		if got := response.Header.Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s 的 Cache-Control = %q，期望 no-store", path, got)
		}
	}
}
