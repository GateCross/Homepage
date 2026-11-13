//go:build ignore

// 冒烟脚本：用临时配置目录启动真实二进制，逐个请求已实现端点并断言响应形态。
// 运行方式（在 apps/api 下）：go run scripts/smoke.go
// 环境无 Docker 时应看到 docker 端点返回 unavailable 而不是失败退出。
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// 冒烟用固定参数。
const (
	waitTimeout = 30 * time.Second
	pollGap     = 100 * time.Millisecond
	// 指向必然拒绝连接的本机端口，用来模拟「环境没有 Docker」
	unreachableDocker = "tcp://127.0.0.1:1"
)

// 配置目录内的五份文件内容；只覆盖本切片读取到的字段。
func fixtureFiles() map[string]string {
	return map[string]string{
		"settings.yaml": "title: 冒烟首页\n" +
			"useEqualHeights: true\n" +
			"layout:\n" +
			"  Server:\n" +
			"    columns: 4\n",
		"services.yaml": "- Server:\n" +
			"    - name: 面板\n" +
			"      href: https://example.com/panel\n" +
			"    - name: 状态容器\n" +
			"      href: http://127.0.0.1:8080\n" +
			"      server: local\n" +
			"      container: web\n" +
			"    - name: 第二个容器\n" +
			"      href: http://127.0.0.1:8081\n" +
			"      server: local\n" +
			"      container: db\n",
		"bookmarks.yaml": "- 常用:\n" +
			"    - name: 文档\n" +
			"      href: https://example.com/docs\n",
		"widgets.yaml": "[]\n",
		"docker.yaml":  "local: " + unreachableDocker + "\n",
	}
}

// 一次请求的观测结果。
type observation struct {
	status      int
	contentType string
	body        []byte
}

// 断言失败计数，全部跑完再统一退出，便于一次看全问题。
type checker struct {
	failures int
}

func (c *checker) pass(format string, args ...any) {
	fmt.Printf("  \033[32mPASS\033[0m "+format+"\n", args...)
}

func (c *checker) fail(format string, args ...any) {
	c.failures++
	fmt.Printf("  \033[31mFAIL\033[0m "+format+"\n", args...)
}

// 条件不成立时记一条失败。
func (c *checker) expect(condition bool, format string, args ...any) bool {
	if condition {
		c.pass(format, args...)
		return true
	}
	c.fail(format, args...)
	return false
}

func main() {
	moduleDir, err := moduleRoot()
	if err != nil {
		fatal("定位模块根目录失败：%v", err)
	}
	tempDir, err := os.MkdirTemp("", "homepage-smoke-")
	if err != nil {
		fatal("创建临时目录失败：%v", err)
	}
	defer func() { _ = os.RemoveAll(tempDir) }()

	configDir := filepath.Join(tempDir, "config")
	if err := writeFixtures(configDir); err != nil {
		fatal("写入临时配置失败：%v", err)
	}

	binaryPath := filepath.Join(tempDir, "homepage-api")
	if runtime.GOOS == "windows" {
		binaryPath += ".exe"
	}
	if err := buildBinary(moduleDir, binaryPath); err != nil {
		fatal("构建失败：%v", err)
	}

	port, err := freePort()
	if err != nil {
		fatal("分配空闲端口失败：%v", err)
	}
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)

	serverLog := filepath.Join(tempDir, "server.log")
	process, logHandle, err := startServer(binaryPath, moduleDir, configDir, port, serverLog)
	if err != nil {
		fatal("启动服务失败：%v", err)
	}
	defer func() {
		if process.Process != nil {
			_ = process.Process.Kill()
		}
		_ = process.Wait()
		_ = logHandle.Close()
	}()

	fmt.Printf("服务地址 %s\n", baseURL)
	fmt.Printf("配置目录 %s\n", configDir)
	if err := waitHealthy(baseURL); err != nil {
		body, _ := os.ReadFile(serverLog)
		fatal("服务未在 %s 内就绪：%v\n服务日志：\n%s", waitTimeout, err, body)
	}

	c := &checker{}
	client := &http.Client{Timeout: 20 * time.Second}

	fmt.Println("\n健康检查与版本")
	checkHealth(c, client, baseURL)
	checkVersion(c, client, baseURL)

	fmt.Println("\n配置读取")
	checkConfig(c, client, baseURL)
	checkEditable(c, client, baseURL)

	fmt.Println("\nDocker 状态（环境无 Docker，应降级为 unavailable）")
	checkDockerStream(c, client, baseURL)
	checkDockerJSON(c, client, baseURL)
	checkDockerLite(c, client, baseURL)
	checkDockerSingle(c, client, baseURL)
	checkDockerContainers(c, client, baseURL)

	fmt.Println("\n数据端点（夹具未登记目标，应全部 403）")
	checkDataEndpointsForbidden(c, client, baseURL)

	fmt.Println("\nIconify 代理（拦截前置校验，不出网）")
	checkIconifyGuards(c, client, baseURL)

	fmt.Println("\n路由兜底")
	checkNotFound(c, client, baseURL)

	_ = logHandle.Sync()
	if c.failures > 0 {
		body, _ := os.ReadFile(serverLog)
		fmt.Printf("\n服务日志：\n%s\n", body)
		fmt.Printf("\n\u7ed3\u679c：%d 项断言失败\n", c.failures)
		os.Exit(1)
	}
	fmt.Println("\n结果：全部断言通过")
}

// 源码所在目录的上一级就是模块根目录，避免依赖调用方工作目录。
func moduleRoot() (string, error) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("无法定位脚本路径")
	}
	return filepath.Dir(filepath.Dir(sourceFile)), nil
}

func writeFixtures(configDir string) error {
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	for name, content := range fixtureFiles() {
		if err := os.WriteFile(filepath.Join(configDir, name), []byte(content), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// 构建到临时目录，避免污染仓库与默认构建缓存之外的路径。
func buildBinary(moduleDir, outPath string) error {
	command := exec.Command("go", "build", "-o", outPath, "./cmd/homepage-api")
	command.Dir = moduleDir
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}

// 取一个空闲端口后立即释放，交给被测进程复用。
func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

// 子进程输出写文件而非管道，既避开管道缓冲问题，失败时也能直接回看日志。
func startServer(binaryPath, workDir, configDir string, port int, logPath string) (*exec.Cmd, *os.File, error) {
	logHandle, err := os.Create(logPath)
	if err != nil {
		return nil, nil, err
	}

	command := exec.Command(binaryPath)
	command.Dir = workDir
	command.Env = append(os.Environ(),
		"CONFIG_DIR="+configDir,
		fmt.Sprintf("PORT=%d", port),
		"HOST=127.0.0.1",
	)
	command.Stdout = logHandle
	command.Stderr = logHandle
	if err := command.Start(); err != nil {
		_ = logHandle.Close()
		return nil, nil, err
	}
	return command, logHandle, nil
}

// 轮询健康检查直到 200，用于等待监听就绪。
func waitHealthy(baseURL string) error {
	deadline := time.Now().Add(waitTimeout)
	client := &http.Client{Timeout: 2 * time.Second}
	var lastErr error
	for time.Now().Before(deadline) {
		response, err := client.Get(baseURL + "/api/health")
		if err == nil {
			status := response.StatusCode
			_ = response.Body.Close()
			if status == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("健康检查返回 %d", status)
		} else {
			lastErr = err
		}
		time.Sleep(pollGap)
	}
	return lastErr
}

func get(client *http.Client, url string) (observation, error) {
	response, err := client.Get(url)
	if err != nil {
		return observation{}, err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return observation{}, err
	}
	return observation{
		status:      response.StatusCode,
		contentType: response.Header.Get("Content-Type"),
		body:        body,
	}, nil
}

// 带指定 Accept 发一次 GET；请求失败时记一条失败并返回 nil。
func getWithAccept(c *checker, client *http.Client, url, accept string) *observation {
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		c.fail("构造请求失败：%v", err)
		return nil
	}
	request.Header.Set("Accept", accept)

	response, err := client.Do(request)
	if err != nil {
		c.fail("请求 %s 失败：%v", url, err)
		return nil
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		c.fail("读取 %s 响应失败：%v", url, err)
		return nil
	}
	return &observation{
		status:      response.StatusCode,
		contentType: response.Header.Get("Content-Type"),
		body:        body,
	}
}

// 健康检查只要求 ok 为 true 且服务名非空。
func checkHealth(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/health")
	if err != nil {
		c.fail("GET /api/health 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/health 状态 %d", observed.status)
	c.expect(strings.HasPrefix(observed.contentType, "application/json"),
		"GET /api/health Content-Type %q", observed.contentType)

	var body struct {
		Ok      bool   `json:"ok"`
		Service string `json:"service"`
	}
	if err := json.Unmarshal(observed.body, &body); err != nil {
		c.fail("GET /api/health 响应不是合法 JSON：%v", err)
		return
	}
	c.expect(body.Ok, "GET /api/health ok=true")
	c.expect(body.Service != "", "GET /api/health service=%q", body.Service)
}

func checkVersion(c *checker, client *http.Client, baseURL string) {
	// check=0 只回本地版本，冒烟环境不应依赖外网
	observed, err := get(client, baseURL+"/api/version?check=0")
	if err != nil {
		c.fail("GET /api/version 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/version 状态 %d", observed.status)

	var body struct {
		Ok              bool    `json:"ok"`
		Version         string  `json:"version"`
		UpdateAvailable bool    `json:"updateAvailable"`
		LatestVersion   *string `json:"latestVersion"`
	}
	if err := json.Unmarshal(observed.body, &body); err != nil {
		c.fail("GET /api/version 响应不是合法 JSON：%v", err)
		return
	}
	c.expect(body.Ok, "GET /api/version ok=true")
	c.expect(body.Version != "", "GET /api/version version=%q", body.Version)
	c.expect(!body.UpdateAvailable, "GET /api/version?check=0 不外网且 updateAvailable=false")
	c.expect(body.LatestVersion == nil, "GET /api/version?check=0 不带 latestVersion")
}

// 规范化配置必须带齐四个顶层字段，且标题来自临时配置。
func checkConfig(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/config")
	if err != nil {
		c.fail("GET /api/config 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/config 状态 %d", observed.status)

	var body struct {
		Settings  map[string]any `json:"settings"`
		Services  []any          `json:"services"`
		Bookmarks []any          `json:"bookmarks"`
		InfoWidg  []any          `json:"infoWidgets"`
	}
	if err := json.Unmarshal(observed.body, &body); err != nil {
		c.fail("GET /api/config 响应不是合法 JSON：%v", err)
		return
	}
	c.expect(body.Settings != nil, "GET /api/config 含 settings")
	c.expect(body.Services != nil, "GET /api/config 含 services")
	c.expect(body.Bookmarks != nil, "GET /api/config 含 bookmarks")
	c.expect(body.InfoWidg != nil, "GET /api/config 含 infoWidgets")
	c.expect(body.Settings["title"] == "冒烟首页", "GET /api/config settings.title=%v", body.Settings["title"])
	c.expect(len(body.Services) == 1, "GET /api/config 服务分组数 %d", len(body.Services))
	c.expect(len(body.Bookmarks) == 1, "GET /api/config 书签分组数 %d", len(body.Bookmarks))

	if bytes.Contains(observed.body, []byte(unreachableDocker)) {
		c.fail("GET /api/config 不得下发 Docker 连接串")
	} else {
		c.pass("GET /api/config 未下发 Docker 连接串")
	}
}

// 可编辑视图是对象，且密钥字段只给状态。
func checkEditable(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/config/editable")
	if err != nil {
		c.fail("GET /api/config/editable 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/config/editable 状态 %d", observed.status)

	var body map[string]any
	if err := json.Unmarshal(observed.body, &body); err != nil {
		c.fail("GET /api/config/editable 响应不是合法 JSON：%v", err)
		return
	}
	_, hasSettings := body["settings"]
	c.expect(hasSettings, "GET /api/config/editable 含 settings")
}

// 批量端点：默认数组，显式要求 NDJSON 时才流式。
func checkDockerStream(c *checker, client *http.Client, baseURL string) {
	type item struct {
		Server    string `json:"server"`
		Container string `json:"container"`
		Result    struct {
			Status string `json:"status"`
			Reason string `json:"reason"`
		} `json:"result"`
	}

	// 默认数组：与前端 fetchDockerBatch 的 Accept 一致
	observed := getWithAccept(c, client, baseURL+"/api/docker/status", "application/json")
	if observed == nil {
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/docker/status 状态 %d", observed.status)
	c.expect(strings.HasPrefix(observed.contentType, "application/json"),
		"GET /api/docker/status 默认 Content-Type %q", observed.contentType)

	var batch struct {
		Ok      bool   `json:"ok"`
		Results []item `json:"results"`
	}
	if err := json.Unmarshal(observed.body, &batch); err != nil {
		c.fail("GET /api/docker/status 默认响应不是合法 JSON：%v", err)
		return
	}
	c.expect(batch.Ok, "GET /api/docker/status 默认 ok=true")
	c.expect(len(batch.Results) == 2, "GET /api/docker/status 默认条目数 %d", len(batch.Results))

	// 显式声明 NDJSON 才逐行推送
	streamed := getWithAccept(c, client, baseURL+"/api/docker/status", "application/x-ndjson")
	if streamed == nil {
		return
	}
	c.expect(streamed.status == http.StatusOK, "流式 GET /api/docker/status 状态 %d", streamed.status)
	c.expect(streamed.contentType == "application/x-ndjson",
		"流式 GET /api/docker/status Content-Type %q", streamed.contentType)

	scanner := bufio.NewScanner(bytes.NewReader(streamed.body))
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	lines := 0
	statuses := map[string]int{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		lines++
		if !json.Valid([]byte(line)) {
			c.fail("流式第 %d 行不是合法 JSON：%s", lines, line)
			continue
		}
		var parsed item
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			c.fail("流式第 %d 行结构不符：%v", lines, err)
			continue
		}
		if parsed.Server == "" || parsed.Container == "" || parsed.Result.Status == "" {
			c.fail("流式第 %d 行缺字段：%s", lines, line)
			continue
		}
		statuses[parsed.Result.Status]++
	}
	if err := scanner.Err(); err != nil {
		c.fail("流式读取失败：%v", err)
		return
	}
	c.expect(lines == 2, "流式输出 %d 行", lines)
	c.expect(statuses["unavailable"] == 2, "流式全部降级为 unavailable：%v", statuses)
}

// 一次性端点：数组形态，条目数与登记数一致。
func checkDockerJSON(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/docker/status.json")
	if err != nil {
		c.fail("GET /api/docker/status.json 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/docker/status.json 状态 %d", observed.status)
	c.expect(strings.HasPrefix(observed.contentType, "application/json"),
		"GET /api/docker/status.json Content-Type %q", observed.contentType)

	var body struct {
		Ok      bool `json:"ok"`
		Results []struct {
			Server    string `json:"server"`
			Container string `json:"container"`
			Result    struct {
				Status string `json:"status"`
			} `json:"result"`
		} `json:"results"`
	}
	if err := json.Unmarshal(observed.body, &body); err != nil {
		c.fail("GET /api/docker/status.json 响应不是合法 JSON：%v", err)
		return
	}
	c.expect(body.Ok, "GET /api/docker/status.json ok=true")
	c.expect(len(body.Results) == 2, "GET /api/docker/status.json 条目数 %d", len(body.Results))

	// 数组顺序按服务名与容器名稳定排序，便于前端复用
	ordered := len(body.Results) == 2 &&
		body.Results[0].Container == "db" &&
		body.Results[1].Container == "web"
	c.expect(ordered, "GET /api/docker/status.json 结果顺序稳定")
}

// stats=0 只查状态，默认仍返回数组且条目齐全。
func checkDockerLite(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/docker/status?stats=0")
	if err != nil {
		c.fail("GET /api/docker/status?stats=0 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/docker/status?stats=0 状态 %d", observed.status)

	var body struct {
		Ok      bool `json:"ok"`
		Results []struct {
			Result struct {
				Status string `json:"status"`
			} `json:"result"`
		} `json:"results"`
	}
	if err := json.Unmarshal(observed.body, &body); err != nil {
		c.fail("GET /api/docker/status?stats=0 响应不是合法 JSON：%v", err)
		return
	}
	c.expect(body.Ok && len(body.Results) == 2,
		"GET /api/docker/status?stats=0 条目数 %d", len(body.Results))
	for index, entry := range body.Results {
		c.expect(entry.Result.Status == "unavailable",
			"GET /api/docker/status?stats=0 第 %d 条降级为 unavailable", index+1)
	}
}

// 单容器端点：已登记容器返回降级状态，未登记容器是 403。
func checkDockerSingle(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/docker/local/web")
	if err != nil {
		c.fail("GET /api/docker/local/web 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusOK, "GET /api/docker/local/web 状态 %d", observed.status)

	var status struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(observed.body, &status); err != nil {
		c.fail("GET /api/docker/local/web 响应不是合法 JSON：%v", err)
		return
	}
	c.expect(status.Status == "unavailable", "GET /api/docker/local/web 降级为 unavailable")

	forbidden, err := get(client, baseURL+"/api/docker/local/not-registered")
	if err != nil {
		c.fail("GET /api/docker/local/not-registered 请求失败：%v", err)
		return
	}
	c.expect(forbidden.status == http.StatusForbidden,
		"GET /api/docker/local/not-registered 状态 %d", forbidden.status)
}

// 容器列表端点：已声明端点返回出站失败，未声明端点是 403。
func checkDockerContainers(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/docker/local/containers")
	if err != nil {
		c.fail("GET /api/docker/local/containers 请求失败：%v", err)
		return
	}
	// 指向必然拒绝连接的本机端口，因此是出站失败而不是 200
	c.expect(observed.status == http.StatusBadGateway,
		"GET /api/docker/local/containers 状态 %d", observed.status)

	forbidden, err := get(client, baseURL+"/api/docker/ghost/containers")
	if err != nil {
		c.fail("GET /api/docker/ghost/containers 请求失败：%v", err)
		return
	}
	c.expect(forbidden.status == http.StatusForbidden,
		"GET /api/docker/ghost/containers 状态 %d", forbidden.status)
}

// 数据端点：夹具未登记任何目标，因此都是 403。
func checkDataEndpointsForbidden(c *checker, client *http.Client, baseURL string) {
	for _, path := range []string{
		"/api/probe/prb_not-registered",
		"/api/widgets/wgt_not-registered",
		"/api/info/inf_not-registered",
	} {
		observed, err := get(client, baseURL+path)
		if err != nil {
			c.fail("GET %s 请求失败：%v", path, err)
			continue
		}
		c.expect(observed.status == http.StatusForbidden, "GET %s 状态 %d", path, observed.status)
		c.expect(strings.HasPrefix(observed.contentType, "application/json"),
			"GET %s 返回 JSON：%q", path, observed.contentType)
	}
}

// Iconify 代理的前置校验：不支持的集合 404、非法名 422、非 GET 404。
// 这三条都在出站之前判定，所以无网络也能跑。
func checkIconifyGuards(c *checker, client *http.Client, baseURL string) {
	cases := []struct {
		path   string
		status int
	}{
		{"/api/icons/iconify/tabler/home.svg", http.StatusNotFound},
		{"/api/icons/iconify/mdi/-bad-name.svg", http.StatusUnprocessableEntity},
		{"/api/icons/iconify/mdi/..%2f..%2fetc.svg", http.StatusUnprocessableEntity},
	}
	for _, testCase := range cases {
		observed, err := get(client, baseURL+testCase.path)
		if err != nil {
			c.fail("GET %s 请求失败：%v", testCase.path, err)
			continue
		}
		c.expect(observed.status == testCase.status,
			"GET %s 状态 %d（期望 %d）", testCase.path, observed.status, testCase.status)
		c.expect(strings.HasPrefix(observed.contentType, "application/json"),
			"GET %s 返回 JSON：%q", testCase.path, observed.contentType)
	}

	// 非 GET 一律 404，不得穿透到代理
	response, err := client.Post(baseURL+"/api/icons/iconify/mdi/home.svg", "application/json", nil)
	if err != nil {
		c.fail("POST iconify 请求失败：%v", err)
		return
	}
	_ = response.Body.Close()
	c.expect(response.StatusCode == http.StatusNotFound,
		"POST /api/icons/iconify/mdi/home.svg 状态 %d", response.StatusCode)
}

// API 未实现路径必须回 JSON 404，非 API 路径回退静态入口，两者不得混淆。
func checkNotFound(c *checker, client *http.Client, baseURL string) {
	observed, err := get(client, baseURL+"/api/does-not-exist")
	if err != nil {
		c.fail("GET /api/does-not-exist 请求失败：%v", err)
		return
	}
	c.expect(observed.status == http.StatusNotFound, "GET /api/does-not-exist 状态 %d", observed.status)
	c.expect(strings.HasPrefix(observed.contentType, "application/json"),
		"GET /api/does-not-exist Content-Type %q", observed.contentType)

	var envelope struct {
		Ok    bool `json:"ok"`
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(observed.body, &envelope); err != nil {
		c.fail("GET /api/does-not-exist 响应不是合法 JSON：%v", err)
		return
	}
	c.expect(!envelope.Ok && envelope.Error.Code == "NOT_FOUND",
		"GET /api/does-not-exist 错误码 %q", envelope.Error.Code)

	// 已登记但不能解析为两段的路径同样是 JSON 404，不回退 SPA
	detail, err := get(client, baseURL+"/api/docker/local/web/extra")
	if err != nil {
		c.fail("GET /api/docker/local/web/extra 请求失败：%v", err)
		return
	}
	c.expect(detail.status == http.StatusNotFound, "GET /api/docker/local/web/extra 状态 %d", detail.status)
	c.expect(strings.HasPrefix(detail.contentType, "application/json"),
		"GET /api/docker/local/web/extra 未回退到 HTML：%q", detail.contentType)

	spa, err := get(client, baseURL+"/some/deep/route")
	if err != nil {
		c.fail("GET /some/deep/route 请求失败：%v", err)
		return
	}
	c.expect(spa.status == http.StatusOK, "GET /some/deep/route 回退入口页状态 %d", spa.status)
	c.expect(strings.HasPrefix(spa.contentType, "text/html"),
		"GET /some/deep/route 返回 HTML：%q", spa.contentType)
}

func fatal(format string, args ...any) {
	fmt.Printf(format+"\n", args...)
	os.Exit(1)
}
