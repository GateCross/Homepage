// Package docker 提供只读的 Docker 状态查询、短 TTL 缓存与流式批量下发。
package docker

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
)

// 只读查询的固定参数。
const (
	// DefaultTimeout 是单次 Docker 请求的超时，调用方可覆盖。
	DefaultTimeout = 10 * time.Second
	// MaxResponseBytes 是单次响应体上限，超出即断开，避免异常端点拖垮进程。
	MaxResponseBytes = 16 << 20
	// CpuSampleMaxAge 是上一拍 CPU 计数的有效期，过期则丢弃，不跨长时间间隔算占用。
	CpuSampleMaxAge = 60 * time.Second
	// CpuSeedGap 是无上一拍时两拍 one-shot 采样之间的补拍间隔。
	CpuSeedGap = 200 * time.Millisecond
)

// containersPrefix 是只读路径的公共前缀。
const containersPrefix = "/containers/"

// ErrorKind 区分失败来源，调用方据此决定降级方式。
type ErrorKind string

// 失败来源分类。
const (
	KindTimeout     ErrorKind = "timeout"
	KindUnreachable ErrorKind = "unreachable"
	KindNotFound    ErrorKind = "not_found"
	KindInvalid     ErrorKind = "invalid"
	KindOther       ErrorKind = "other"
)

// Error 是 Docker 查询的可判定错误，Message 为可外露的中文原因。
type Error struct {
	Kind    ErrorKind
	Message string
}

func (e *Error) Error() string { return e.Message }

// Request 是一次只读请求，方法恒为 GET。
type Request struct {
	Method string
	Path   string
}

// Response 是状态码与完整响应体。
type Response struct {
	StatusCode int
	Body       []byte
}

// Transport 执行一次只读请求；测试可注入计数与阻塞实现。
type Transport interface {
	Do(ctx context.Context, endpoint config.DockerEndpoint, req Request) (Response, error)
}

// Client 绑定单个端点，只允许白名单内的只读请求。
type Client struct {
	endpoint  config.DockerEndpoint
	transport Transport
	timeout   time.Duration
	samples   *CpuSampleStore
	seedGap   time.Duration
	now       func() time.Time
}

// ClientOptions 覆盖默认超时、传输层、CPU 采样存储与时序函数。
type ClientOptions struct {
	Timeout   time.Duration
	Transport Transport
	Samples   *CpuSampleStore
	SeedGap   time.Duration
	Now       func() time.Time
}

// 构造绑定单个端点的客户端；未指定的依赖落到进程默认实现。
func NewClient(endpoint config.DockerEndpoint, opts ClientOptions) *Client {
	client := &Client{
		endpoint:  endpoint,
		transport: opts.Transport,
		timeout:   opts.Timeout,
		samples:   opts.Samples,
		seedGap:   opts.SeedGap,
		now:       opts.Now,
	}
	if client.transport == nil {
		client.transport = NewHTTPTransport()
	}
	if client.timeout <= 0 {
		client.timeout = DefaultTimeout
	}
	if client.samples == nil {
		client.samples = defaultCpuSamples
	}
	if client.seedGap <= 0 {
		client.seedGap = CpuSeedGap
	}
	if client.now == nil {
		client.now = time.Now
	}
	return client
}

// HTTPTransport 按端点复用连接；unix 走本地 socket，tcp 直接拨号，TLS 端点跳过证书校验。
type HTTPTransport struct {
	mu      sync.Mutex
	targets map[string]*transportTarget
}

// transportTarget 是同一端点共享的 HTTP 客户端与基地址。
type transportTarget struct {
	client  *http.Client
	baseURL string
}

// 创建空的连接池；首次请求时才建立具体端点的客户端。
func NewHTTPTransport() *HTTPTransport {
	return &HTTPTransport{targets: make(map[string]*transportTarget)}
}

// 执行一次只读请求；非 GET 或白名单外路径在拨号前即被拒绝。
func (t *HTTPTransport) Do(ctx context.Context, endpoint config.DockerEndpoint, req Request) (Response, error) {
	if req.Method != http.MethodGet {
		return Response{}, &Error{Kind: KindInvalid, Message: "Docker 客户端仅允许只读查询"}
	}
	if !isAllowedReadPath(req.Path) {
		return Response{}, &Error{Kind: KindInvalid, Message: "Docker 客户端拒绝白名单外的路径"}
	}

	target, err := t.targetFor(endpoint)
	if err != nil {
		return Response{}, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, target.baseURL+req.Path, nil)
	if err != nil {
		return Response{}, &Error{Kind: KindInvalid, Message: "构造 Docker 请求失败"}
	}
	httpReq.Host = "localhost"
	httpReq.Header.Set("Accept", "application/json")

	resp, err := target.client.Do(httpReq)
	if err != nil {
		return Response{}, transportError(err)
	}
	defer func() { _ = resp.Body.Close() }()

	// 多读一个字节即可判定超限，随后关闭连接不再续读
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil {
		return Response{}, transportError(err)
	}
	if len(body) > MaxResponseBytes {
		return Response{}, &Error{Kind: KindInvalid, Message: "Docker 响应体积超过限制"}
	}
	if resp.StatusCode == http.StatusNotFound {
		return Response{}, &Error{Kind: KindNotFound, Message: "容器不存在"}
	}
	return Response{StatusCode: resp.StatusCode, Body: body}, nil
}

// 取或建端点对应的客户端；同一端点的连接在多次请求间复用。
func (t *HTTPTransport) targetFor(endpoint config.DockerEndpoint) (*transportTarget, error) {
	key := endpointKey(endpoint)

	t.mu.Lock()
	defer t.mu.Unlock()
	if target, ok := t.targets[key]; ok {
		return target, nil
	}

	target := &transportTarget{}
	switch endpoint.Kind {
	case config.DockerEndpointUnix:
		if endpoint.SocketPath == "" {
			return nil, &Error{Kind: KindInvalid, Message: "Docker unix 端点缺少 socket 路径"}
		}
		socketPath := endpoint.SocketPath
		dialer := &net.Dialer{}
		target.client = &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", socketPath)
			},
			MaxIdleConnsPerHost: 24,
			IdleConnTimeout:     90 * time.Second,
		}}
		target.baseURL = "http://localhost"

	case config.DockerEndpointTCP:
		addr := net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port))
		transport := &http.Transport{
			MaxIdleConnsPerHost: 24,
			IdleConnTimeout:     90 * time.Second,
		}
		scheme := "http"
		if endpoint.TLS {
			scheme = "https"
			// 局域网 Docker TLS 常见自签证书，与现有实现一致地跳过校验
			transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec
		}
		target.client = &http.Client{Transport: transport}
		target.baseURL = scheme + "://" + addr

	default:
		return nil, &Error{Kind: KindInvalid, Message: "Docker 端点类型无效"}
	}

	t.targets[key] = target
	return target, nil
}

// 把传输层错误归类为超时或不可达。
func transportError(err error) error {
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return &Error{Kind: KindTimeout, Message: "查询 Docker 超时"}
	}
	return &Error{Kind: KindUnreachable, Message: "Docker 端点不可达"}
}

// 端点指纹，用于连接复用与 CPU 采样键。
func endpointKey(endpoint config.DockerEndpoint) string {
	if endpoint.Kind == config.DockerEndpointUnix {
		return "unix:" + endpoint.SocketPath
	}
	scheme := "tcp"
	if endpoint.TLS {
		scheme = "https"
	}
	return scheme + ":" + net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port))
}

// 只接受容器详情、一次性 stats 与容器列表三种只读路径。
func isAllowedReadPath(path string) bool {
	// 列表路径可带 all=true 查询；只放行这一种查询，其它参数一律拒绝
	if path == "/containers/json" || path == listAllPath {
		return true
	}
	if !strings.HasPrefix(path, containersPrefix) {
		return false
	}
	rest := path[len(containersPrefix):]
	if rest == "" {
		return false
	}

	if strings.HasSuffix(rest, "/json") {
		return validPathSegment(strings.TrimSuffix(rest, "/json"))
	}

	// stats 必须显式要求非流式，缺省 query 会让 Engine 持续推送
	queryAt := strings.IndexByte(rest, '?')
	if queryAt < 0 {
		return false
	}
	nameAndStats := rest[:queryAt]
	if !strings.HasSuffix(nameAndStats, "/stats") {
		return false
	}
	name := strings.TrimSuffix(nameAndStats, "/stats")
	if !validPathSegment(name) {
		return false
	}

	values, err := url.ParseQuery(rest[queryAt+1:])
	if err != nil {
		return false
	}
	for key := range values {
		if key != "stream" && key != "one-shot" {
			return false
		}
	}
	if values.Get("stream") != "0" {
		return false
	}
	if oneShot, ok := values["one-shot"]; ok {
		if len(oneShot) != 1 || (oneShot[0] != "1" && oneShot[0] != "true") {
			return false
		}
	}
	return true
}

// 容器名只允许不含分隔符与上跳片段的单个路径片段。
func validPathSegment(segment string) bool {
	return segment != "" && !strings.Contains(segment, "/") && !strings.Contains(segment, "..")
}

// 容器名去掉首尾空白并拒绝路径分隔符与上跳片段。
func normalizeContainerName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", &Error{Kind: KindInvalid, Message: "容器名称无效"}
	}
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", &Error{Kind: KindInvalid, Message: "容器名称无效"}
	}
	return name, nil
}

// 拼容器详情路径，名称按路径片段转义。
func buildInspectPath(container string) (string, error) {
	name, err := normalizeContainerName(container)
	if err != nil {
		return "", err
	}
	return containersPrefix + url.PathEscape(name) + "/json", nil
}

// 拼一次性 stats 路径；one-shot 让 Engine 立即返回当前计数。
func buildStatsPath(container string) (string, error) {
	name, err := normalizeContainerName(container)
	if err != nil {
		return "", err
	}
	return containersPrefix + url.PathEscape(name) + "/stats?stream=0&one-shot=1", nil
}

// 发起只读请求并为单次调用套上超时。
func (c *Client) request(ctx context.Context, path string) (Response, error) {
	if c.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.timeout)
		defer cancel()
	}
	return c.transport.Do(ctx, c.endpoint, Request{Method: http.MethodGet, Path: path})
}

// 查询容器状态。Docker 侧失败映射为 unavailable 并保留原因；只有 ctx 取消才返回错误。
func (c *Client) Inspect(ctx context.Context, container string) (domain.DockerStatusResponse, error) {
	path, err := buildInspectPath(container)
	if err != nil {
		return unavailable("容器名称无效"), nil
	}

	resp, err := c.request(ctx, path)
	if err != nil {
		if ctx.Err() != nil {
			return domain.DockerStatusResponse{}, ctx.Err()
		}
		var dockerErr *Error
		if errors.As(err, &dockerErr) {
			switch dockerErr.Kind {
			case KindNotFound:
				return unavailable("容器不存在"), nil
			case KindTimeout:
				return unavailable("查询 Docker 超时"), nil
			case KindInvalid:
				return unavailable(dockerErr.Message), nil
			}
		}
		return unavailable("Docker 端点不可达"), nil
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return unavailable("Docker 接口返回错误"), nil
	}

	var payload any
	if err := json.Unmarshal(resp.Body, &payload); err != nil {
		return unavailable("Docker 返回了无效 JSON"), nil
	}
	return mapInspectToStatus(payload), nil
}

// 拉取一次性资源占用；任一环节失败都返回错误，调用方据此降级且不写缓存。
func (c *Client) Stats(ctx context.Context, container string) (domain.DockerResourceStats, error) {
	return c.fetchStats(ctx, container)
}

// 取得一次 stats 报文；状态码与 JSON 异常都视为失败。
func (c *Client) statsPayload(ctx context.Context, container string) (any, error) {
	path, err := buildStatsPath(container)
	if err != nil {
		return nil, err
	}
	resp, err := c.request(ctx, path)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &Error{Kind: KindOther, Message: "Docker 接口返回错误"}
	}
	var payload any
	if err := json.Unmarshal(resp.Body, &payload); err != nil {
		return nil, &Error{Kind: KindInvalid, Message: "Docker 返回了无效 JSON"}
	}
	return payload, nil
}

// 采样资源占用。one-shot 的 precpu 常为空，用进程内上一拍差分；
// 没有上一拍时补拉第二拍，保证首个响应尽量同时带上 CPU 与内存。
func (c *Client) fetchStats(ctx context.Context, container string) (domain.DockerResourceStats, error) {
	key := c.sampleKey(container)
	previous, hasPrevious := c.samples.get(key)
	var previousSample *CpuCounterSample
	if hasPrevious {
		previousSample = &previous
	}

	firstPayload, err := c.statsPayload(ctx, container)
	if err != nil {
		return domain.DockerResourceStats{}, err
	}
	first := mapStatsToResources(firstPayload, previousSample, c.now())
	if first.sample != nil {
		c.samples.set(key, *first.sample)
	}

	// 已有 cpu%，或解析不到计数：内存与 CPU 同包返回
	if first.resources.CPUPercent != nil || first.sample == nil {
		return first.resources, nil
	}

	if err := sleepContext(ctx, c.seedGap); err != nil {
		return domain.DockerResourceStats{}, err
	}

	secondPayload, err := c.statsPayload(ctx, container)
	if err != nil {
		// 第二拍失败时保留第一拍的内存数据
		return first.resources, nil
	}
	second := mapStatsToResources(secondPayload, first.sample, c.now())
	if second.sample != nil {
		c.samples.set(key, *second.sample)
	}
	return mergeResources(first.resources, second.resources), nil
}

// CPU 采样按端点与容器分开存放，避免同名容器串味。
func (c *Client) sampleKey(container string) string {
	return endpointKey(c.endpoint) + "\x00" + container
}

// CpuCounterSample 是跨请求计算 CPU 占用的计数快照，不属于 API 契约。
type CpuCounterSample struct {
	TotalUsage  float64
	SystemUsage float64
	OnlineCPUs  int
	At          time.Time
}

// CpuSampleStore 保存每个端点与容器最近一拍的 CPU 计数。
type CpuSampleStore struct {
	mu      sync.Mutex
	samples map[string]CpuCounterSample
}

// 创建空的采样表。
func NewCpuSampleStore() *CpuSampleStore {
	return &CpuSampleStore{samples: make(map[string]CpuCounterSample)}
}

// 读取上一拍；不存在时返回零值。
func (s *CpuSampleStore) get(key string) (CpuCounterSample, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sample, ok := s.samples[key]
	return sample, ok
}

// 写入本拍并顺带清理过期样本；样本量与容器数同阶。
func (s *CpuSampleStore) set(key string, sample CpuCounterSample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for otherKey, other := range s.samples {
		if sample.At.Sub(other.At) > CpuSampleMaxAge {
			delete(s.samples, otherKey)
		}
	}
	s.samples[key] = sample
}

// 进程默认采样表：每次查询都新建客户端，采样必须跨客户端共享。
var defaultCpuSamples = NewCpuSampleStore()

// statsResult 是本拍资源与计数的组合。
type statsResult struct {
	resources domain.DockerResourceStats
	sample    *CpuCounterSample
}

// 把 stats 报文映射为资源占用，并返回本拍计数供下次差分。
func mapStatsToResources(payload any, previous *CpuCounterSample, now time.Time) statsResult {
	root, ok := payload.(map[string]any)
	if !ok {
		return statsResult{}
	}

	result := statsResult{}
	sample := extractCpuSample(root, now)
	result.sample = sample

	// 1) 进程内上一拍差分（one-shot 主路径）
	var cpuPercent float64
	hasPercent := false
	if sample != nil {
		if value, ok := cpuPercentFromSamples(previous, *sample); ok {
			cpuPercent, hasPercent = value, true
		}
	}

	// 2) 回退 precpu_stats：one-shot 时常有键但 system 计数为 0，不能当有效上一拍
	if !hasPercent {
		curTotal, curTotalOK := nestedNumber(root, "cpu_stats", "cpu_usage", "total_usage")
		curSystem, curSystemOK := nestedNumber(root, "cpu_stats", "system_cpu_usage")
		preTotal, preTotalOK := nestedNumber(root, "precpu_stats", "cpu_usage", "total_usage")
		preSystem, preSystemOK := nestedNumber(root, "precpu_stats", "system_cpu_usage")
		if curTotalOK && curSystemOK && preTotalOK && preSystemOK && preSystem > 0 {
			cpuDelta := curTotal - preTotal
			systemDelta := curSystem - preSystem
			if systemDelta > 0 && cpuDelta >= 0 {
				cpuPercent = clampPercent(cpuDelta / systemDelta * float64(onlineCPUs(root)) * 100)
				hasPercent = true
			}
		}
	}
	if hasPercent {
		result.resources.CPUPercent = float64Ptr(cpuPercent)
	}

	usage, hasUsage := nestedNumber(root, "memory_stats", "usage")
	limit, hasLimit := nestedNumber(root, "memory_stats", "limit")
	if hasUsage && usage >= 0 {
		result.resources.MemoryUsageBytes = int64Ptr(usage)
	}
	if hasLimit && limit > 0 {
		result.resources.MemoryLimitBytes = int64Ptr(limit)
	}

	if hasUsage && hasLimit && limit > 0 {
		// 优先 cgroup v2 的 inactive_file，回退 total_inactive_file 与 cache
		inactiveFile := 0.0
		if value, ok := nestedNumber(root, "memory_stats", "stats", "inactive_file"); ok {
			inactiveFile = value
		} else if value, ok := nestedNumber(root, "memory_stats", "stats", "total_inactive_file"); ok {
			inactiveFile = value
		} else if value, ok := nestedNumber(root, "memory_stats", "stats", "cache"); ok {
			inactiveFile = value
		}
		used := math.Max(0, usage-math.Max(0, inactiveFile))
		result.resources.MemoryPercent = float64Ptr(clampPercent(used / limit * 100))
		result.resources.MemoryUsageBytes = int64Ptr(used)
	}

	return result
}

// 从 stats 报文提取本拍 CPU 计数；缺少或类型不符时返回空。
func extractCpuSample(root map[string]any, at time.Time) *CpuCounterSample {
	totalUsage, ok := nestedNumber(root, "cpu_stats", "cpu_usage", "total_usage")
	if !ok {
		return nil
	}
	systemUsage, ok := nestedNumber(root, "cpu_stats", "system_cpu_usage")
	if !ok {
		return nil
	}
	return &CpuCounterSample{
		TotalUsage:  totalUsage,
		SystemUsage: systemUsage,
		OnlineCPUs:  onlineCPUs(root),
		At:          at,
	}
}

// 在线 CPU 数：优先 online_cpus，缺失时按 percpu_usage 长度推断，最小为 1。
func onlineCPUs(root map[string]any) int {
	if value, ok := nestedNumber(root, "cpu_stats", "online_cpus"); ok && value > 0 {
		return int(value)
	}
	cpuStats, ok := root["cpu_stats"].(map[string]any)
	if !ok {
		return 1
	}
	cpuUsage, ok := cpuStats["cpu_usage"].(map[string]any)
	if !ok {
		return 1
	}
	perCPU, ok := cpuUsage["percpu_usage"].([]any)
	if !ok || len(perCPU) == 0 {
		return 1
	}
	return len(perCPU)
}

// 用两拍计数算占用率；上一拍缺失、过期或计数回绕时返回空，不伪造 0。
func cpuPercentFromSamples(previous *CpuCounterSample, current CpuCounterSample) (float64, bool) {
	if previous == nil {
		return 0, false
	}
	age := current.At.Sub(previous.At)
	if age > CpuSampleMaxAge || age < 0 {
		return 0, false
	}
	cpuDelta := current.TotalUsage - previous.TotalUsage
	systemDelta := current.SystemUsage - previous.SystemUsage
	if systemDelta <= 0 || cpuDelta < 0 {
		return 0, false
	}
	online := current.OnlineCPUs
	if online <= 0 {
		online = previous.OnlineCPUs
	}
	if online <= 0 {
		online = 1
	}
	return clampPercent(cpuDelta / systemDelta * float64(online) * 100), true
}

// 把数值夹在 0–100；非有限值按 0 处理。
func clampPercent(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Min(100, math.Max(0, value))
}

// 按路径逐层取数值；中间节点缺失、非对象或值类型不符时返回空。
func nestedNumber(root map[string]any, path ...string) (float64, bool) {
	var cursor any = root
	for _, key := range path {
		object, ok := cursor.(map[string]any)
		if !ok {
			return 0, false
		}
		value, ok := object[key]
		if !ok {
			return 0, false
		}
		cursor = value
	}
	number, ok := cursor.(float64)
	if !ok {
		return 0, false
	}
	return number, true
}

// 取字符串字段并去首尾空白。
func stringValue(object map[string]any, key string) (string, bool) {
	value, ok := object[key].(string)
	if !ok {
		return "", false
	}
	return strings.TrimSpace(value), true
}

// 取布尔字段；缺失或类型不符时按 false。
func boolValue(object map[string]any, key string) bool {
	value, ok := object[key].(bool)
	return ok && value
}

// 读取 HEALTHCHECK 结果，仅三种受支持取值。
func readHealth(state map[string]any) *string {
	health, ok := state["Health"].(map[string]any)
	if !ok {
		return nil
	}
	status, ok := stringValue(health, "Status")
	if !ok {
		return nil
	}
	switch strings.ToLower(status) {
	case domain.DockerHealthHealthy:
		return strPtr(domain.DockerHealthHealthy)
	case domain.DockerHealthUnhealthy:
		return strPtr(domain.DockerHealthUnhealthy)
	case domain.DockerHealthStarting:
		return strPtr(domain.DockerHealthStarting)
	}
	return nil
}

// 附加健康与细节；unavailable 状态不挂附加字段。
func withMeta(base domain.DockerStatusResponse, health *string, detail string) domain.DockerStatusResponse {
	if base.Status == domain.DockerStatusUnavailable {
		return base
	}
	if health != nil {
		base.Health = health
	}
	if detail != "" {
		base.Detail = strPtr(detail)
	}
	return base
}

// 把容器详情报文映射为对外状态；瞬态优先于 Running 布尔。
func mapInspectToStatus(payload any) domain.DockerStatusResponse {
	root, ok := payload.(map[string]any)
	if !ok {
		return unavailable("Docker 返回了异常结构")
	}

	rawState, _ := root["State"]
	state, isStateObject := rawState.(map[string]any)
	if !isStateObject {
		// 少数实现把状态放在顶层
		if text, ok := stringValue(root, "Status"); ok {
			return mapStatusString(text)
		}
		if text, ok := rawState.(string); ok {
			return mapStatusString(text)
		}
		return unavailable("Docker 返回了异常结构")
	}

	statusText, hasStatusText := stringValue(state, "Status")
	detail := ""
	if hasStatusText {
		detail = truncateDetail(statusText)
	}
	health := readHealth(state)
	statusLower := strings.ToLower(statusText)

	if boolValue(state, "Restarting") || statusLower == "restarting" {
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusRestarting}, health, detail)
	}
	if boolValue(state, "Paused") || statusLower == "paused" {
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusPaused}, health, detail)
	}
	if statusLower == "created" || statusLower == "removing" {
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusStarting}, health, detail)
	}

	running, hasRunning := state["Running"].(bool)
	if hasRunning && running {
		// HEALTHCHECK 仍在 starting 时主状态仍为 running
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusRunning}, health, detail)
	}

	pid, hasPID := state["Pid"].(float64)
	if (hasRunning && !running) || hasStatusText || (hasPID && pid == 0) {
		if statusLower == "dead" {
			deadDetail := detail
			if !hasStatusText {
				deadDetail = "已死亡"
			}
			return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusStopped}, nil, deadDetail)
		}
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusStopped}, health, detail)
	}

	if hasStatusText {
		return mapStatusString(statusText)
	}
	return unavailable("无法判定容器状态")
}

// 把 Docker 的状态文案映射为对外状态，未知文案返回 unavailable。
func mapStatusString(raw string) domain.DockerStatusResponse {
	text := strings.TrimSpace(raw)
	lower := strings.ToLower(text)
	detail := truncateDetail(text)

	switch {
	case lower == "running" || strings.HasPrefix(lower, "up "):
		// 列表 Status 常见 "Up 2 hours (healthy)"
		var health *string
		switch {
		case strings.Contains(lower, "(healthy)"):
			health = strPtr(domain.DockerHealthHealthy)
		case strings.Contains(lower, "(unhealthy)"):
			health = strPtr(domain.DockerHealthUnhealthy)
		case strings.Contains(lower, "(health: starting)"), strings.Contains(lower, "(starting)"):
			health = strPtr(domain.DockerHealthStarting)
		}
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusRunning}, health, detail)

	case lower == "restarting" || strings.HasPrefix(lower, "restarting"):
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusRestarting}, nil, detail)

	case lower == "paused" || strings.HasPrefix(lower, "paused"):
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusPaused}, nil, detail)

	case lower == "created" || lower == "removing" || strings.HasPrefix(lower, "created"):
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusStarting}, nil, detail)

	case lower == "exited", strings.HasPrefix(lower, "exited"),
		lower == "dead", strings.HasPrefix(lower, "dead"), lower == "stopped":
		return withMeta(domain.DockerStatusResponse{Status: domain.DockerStatusStopped}, nil, detail)
	}

	return unavailable("无法判定容器状态")
}

// 截断细节文案，最长 80 个字符并追加省略号。
func truncateDetail(text string) string {
	trimmed := strings.TrimSpace(text)
	runes := []rune(trimmed)
	const maxDetailRunes = 80
	if len(runes) <= maxDetailRunes {
		return trimmed
	}
	return string(runes[:maxDetailRunes]) + "…"
}

// 构造 unavailable 结果。
func unavailable(reason string) domain.DockerStatusResponse {
	return domain.DockerStatusResponse{
		Status: domain.DockerStatusUnavailable,
		Reason: strPtr(reason),
	}
}

// 合并两拍资源，后一拍覆盖前一拍。
func mergeResources(base, overlay domain.DockerResourceStats) domain.DockerResourceStats {
	if overlay.CPUPercent != nil {
		base.CPUPercent = overlay.CPUPercent
	}
	if overlay.MemoryPercent != nil {
		base.MemoryPercent = overlay.MemoryPercent
	}
	if overlay.MemoryUsageBytes != nil {
		base.MemoryUsageBytes = overlay.MemoryUsageBytes
	}
	if overlay.MemoryLimitBytes != nil {
		base.MemoryLimitBytes = overlay.MemoryLimitBytes
	}
	return base
}

// 把资源占用并入运行态；非 running 原样返回。
func mergeRunningWithStats(status domain.DockerStatusResponse, stats domain.DockerResourceStats) domain.DockerStatusResponse {
	if status.Status != domain.DockerStatusRunning {
		return status
	}
	merged := domain.DockerStatusResponse{
		Status: status.Status,
		Health: status.Health,
		Detail: status.Detail,
	}
	merged.DockerResourceStats = stats
	return merged
}

// 构造指针，供可选字段使用。
func strPtr(value string) *string { return &value }

// 构造浮点指针。
func float64Ptr(value float64) *float64 { return &value }

// 字节数按四舍五入转成整型指针。
func int64Ptr(value float64) *int64 {
	rounded := int64(math.Round(value))
	return &rounded
}

// 可被 ctx 打断的等待，用于两拍采样之间。
func sleepContext(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
