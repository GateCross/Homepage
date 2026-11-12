package docker

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
)

// 端点路径；批量状态按内容协商决定数组或流式，status.json 固定数组。
const (
	// DockerPrefix 是全部 Docker 端点共用的前缀。
	DockerPrefix   = "/api/docker/"
	StatusPath     = "/api/docker/status"
	StatusJSONPath = "/api/docker/status.json"
	// ContainersSegment 是列表端点的末段，先于单容器通配匹配。
	ContainersSegment = "containers"
	// NDJSONContentType 是逐行 JSON 的响应类型。
	NDJSONContentType = "application/x-ndjson"
	// JSONContentType 是常规 JSON 响应类型。
	JSONContentType = "application/json; charset=utf-8"
)

// 固定失败文案，均不含内部细节。
const (
	msgTargetForbidden = "Docker 目标未登记或无权访问"
	msgTimeout         = "查询 Docker 超时"
	msgUnreachable     = "Docker 端点不可达"
	msgAPINotFound     = "未找到请求的 API 接口"
	msgInternal        = "服务暂时不可用，请稍后重试"
	msgSecretLeak      = "Docker 响应疑似包含敏感值，已拒绝下发"
)

// AllowListFunc 按请求返回当次允许列表；返回值不得被修改。
type AllowListFunc func(*http.Request) *config.AllowList

// 提供 Docker 状态的单容器、列表与批量三种下发方式。
// 缓存、并发去重与连接在全部请求间共享，因此只能通过构造函数创建。
type Handler struct {
	allowList AllowListFunc
	base      *Service
}

// 创建处理器；allowList 为 nil 时一律按空列表处理，即不发起任何 Docker 请求。
func NewHandler(allowList AllowListFunc, opts Options) *Handler {
	return &Handler{allowList: allowList, base: NewService(nil, opts)}
}

// 按路径分派到四个端点；未识别的子路径按 API 契约返回 JSON 404。
// 方法只接受 GET，其它方法同样回 JSON 404，不做任何写操作。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		WriteNotFound(w)
		return
	}

	switch r.URL.Path {
	case StatusPath:
		h.ServeStatus(w, r)
		return
	case StatusJSONPath:
		h.ServeJSON(w, r)
		return
	}

	segments, ok := dockerPathSegments(r.URL.Path)
	if !ok {
		WriteNotFound(w)
		return
	}
	if segments[1] == ContainersSegment {
		h.ServeContainers(w, r, segments[0])
		return
	}
	h.ServeContainer(w, r, segments[0], segments[1])
}

// 把 /api/docker/ 之后的部分切成恰好两段；空段与多段都不算合法路径。
func dockerPathSegments(urlPath string) ([2]string, bool) {
	rest, ok := strings.CutPrefix(urlPath, DockerPrefix)
	if !ok {
		return [2]string{}, false
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return [2]string{}, false
	}
	return [2]string{parts[0], parts[1]}, true
}

// 按请求构造服务副本：目标只来自当次允许列表，未登记的容器不会产生任何 Docker 请求。
func (h *Handler) serviceFor(r *http.Request) *Service {
	return h.base.withTargets(ListTargets(h.currentAllowList(r)), includeStats(r))
}

// 取当次允许列表；未注入时按空列表处理。
func (h *Handler) currentAllowList(r *http.Request) *config.AllowList {
	if h.allowList == nil {
		return nil
	}
	return h.allowList(r)
}

// 查询参数 stats=0|false|no 时只查状态，其余取值默认含资源占用。
func includeStats(r *http.Request) bool {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("stats"))) {
	case "0", "false", "no":
		return false
	}
	return true
}

// 按 Accept 协商：显式要求 NDJSON 时流式，其余一律返回数组 JSON。
// 前端批量请求默认只发 Accept: application/json，因此拿到的是数组。
func (h *Handler) ServeStatus(w http.ResponseWriter, r *http.Request) {
	if acceptsNDJSON(r.Header.Get("Accept")) {
		h.ServeStream(w, r)
		return
	}
	h.ServeJSON(w, r)
}

// 按 Accept 判断是否要流式：显式列出 application/x-ndjson 才算，q=0 视为拒绝。
func acceptsNDJSON(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), NDJSONContentType) {
			continue
		}
		for _, parameter := range fields[1:] {
			key, value, found := strings.Cut(parameter, "=")
			if found && strings.EqualFold(strings.TrimSpace(key), "q") && isZeroQuality(value) {
				return false
			}
		}
		return true
	}
	return false
}

// 权重写法的 0 值；0.001 这类仍算接受。
func isZeroQuality(raw string) bool {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return false
	}
	return value <= 0
}

// 流式下发：先刷出响应头，随后每就绪一条写一行 JSON 并立即刷新。
func (h *Handler) ServeStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteInternalError(w)
		return
	}

	header := w.Header()
	header.Set("Content-Type", NDJSONContentType)
	// 反向代理缓冲会让流式退化成一次性返回
	header.Set("X-Accel-Buffering", "no")
	header.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	encoder := json.NewEncoder(w)
	for item := range h.serviceFor(r).Stream(r.Context()) {
		if err := encoder.Encode(item); err != nil {
			// 客户端已断开，停止继续查询
			return
		}
		flusher.Flush()
	}
}

// 一次性下发：读完整批后按数组契约返回，序列化后再做一次密钥扫描。
func (h *Handler) ServeJSON(w http.ResponseWriter, r *http.Request) {
	items := h.serviceFor(r).Collect(r.Context())
	if r.Context().Err() != nil {
		return
	}
	h.writePayload(w, BatchResponse{Ok: true, Results: items}, h.currentAllowList(r))
}

// 查询单个已登记容器；未登记时 0 次 Docker 请求。
func (h *Handler) ServeContainer(w http.ResponseWriter, r *http.Request, serverRaw, containerRaw string) {
	allowList := h.currentAllowList(r)
	server, ok := decodePathSegment(serverRaw)
	if !ok {
		WriteForbidden(w)
		return
	}
	container, ok := decodePathSegment(containerRaw)
	if !ok {
		WriteForbidden(w)
		return
	}

	target, authorized := AuthorizeLookup(allowList, server, container)
	if !authorized {
		WriteForbidden(w)
		return
	}

	// 与批量共享缓存；单容器始终带资源占用，与 TS 路由一致
	service := h.base.withTargets([]Target{target}, true)
	item, ok := service.Query(r.Context(), target)
	if !ok {
		return
	}
	h.writePayload(w, item.Result, allowList)
}

// 列出端点上的全部容器；只要求 server 已在 docker.yaml 声明。
func (h *Handler) ServeContainers(w http.ResponseWriter, r *http.Request, serverRaw string) {
	allowList := h.currentAllowList(r)
	server, ok := decodePathSegment(serverRaw)
	if !ok {
		WriteForbidden(w)
		return
	}

	server, endpoint, authorized := AuthorizeEndpoint(allowList, server)
	if !authorized {
		WriteForbidden(w)
		return
	}

	containers, err := h.base.clientFor(endpoint).List(r.Context())
	if err != nil {
		writeListFailure(w, err)
		return
	}
	h.writePayload(w, domain.DockerContainersResponse{Ok: true, Server: server, Containers: containers}, allowList)
}

// 路径片段按百分号解码；非法转义按未登记处理，不让原始串进入授权判定。
func decodePathSegment(raw string) (string, bool) {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(decoded)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// 序列化后扫描允许列表中的敏感值；命中即改发 INTERNAL，绝不下发原响应。
func (h *Handler) writePayload(w http.ResponseWriter, payload any, allowList *config.AllowList) {
	body, err := json.Marshal(payload)
	if err != nil {
		WriteInternalError(w)
		return
	}
	if config.JSONContainsAnySecret(body, config.CollectSensitiveValues(allowList)) {
		log.Printf("%s", msgSecretLeak)
		WriteInternalError(w)
		return
	}

	header := w.Header()
	header.Set("Content-Type", JSONContentType)
	header.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// 列表失败按可判定错误映射：超时 504，其余出站失败 502。
func writeListFailure(w http.ResponseWriter, err error) {
	var dockerErr *Error
	if !errors.As(err, &dockerErr) {
		WriteInternalError(w)
		return
	}
	switch dockerErr.Kind {
	case KindTimeout:
		writeEnvelope(w, http.StatusGatewayTimeout, "EXTERNAL_TIMEOUT", msgTimeout)
	case KindUnreachable:
		writeEnvelope(w, http.StatusBadGateway, "EXTERNAL_FAILURE", msgUnreachable)
	default:
		writeEnvelope(w, http.StatusBadGateway, "EXTERNAL_FAILURE", dockerErr.Message)
	}
}

// 失败时输出与 API 契约一致的错误信封。
func WriteInternalError(w http.ResponseWriter) {
	writeEnvelope(w, http.StatusInternalServerError, "INTERNAL", msgInternal)
}

// 未登记或无权访问统一 403，调用方在此之前不得发起任何 Docker 请求。
func WriteForbidden(w http.ResponseWriter) {
	writeEnvelope(w, http.StatusForbidden, "FORBIDDEN", msgTargetForbidden)
}

// 未实现或已登记前缀下的未知路径按 404 信封返回。
func WriteNotFound(w http.ResponseWriter) {
	writeEnvelope(w, http.StatusNotFound, "NOT_FOUND", msgAPINotFound)
}

// 输出错误信封；响应体极小，直接拼装不额外缓冲。
func writeEnvelope(w http.ResponseWriter, status int, code, message string) {
	body, err := json.Marshal(domain.ErrorEnvelope{
		Ok:    false,
		Error: domain.PublicError{Message: message, Code: &code},
	})
	if err != nil {
		w.WriteHeader(status)
		return
	}
	header := w.Header()
	header.Set("Content-Type", JSONContentType)
	header.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// 严格校验列表查询：端点已在 docker.yaml 声明才放行。
// 未命中时返回 false，调用方不得创建客户端、不得发任何 Docker 请求。
func AuthorizeEndpoint(allowList *config.AllowList, serverRaw string) (string, config.DockerEndpoint, bool) {
	if allowList == nil {
		return "", config.DockerEndpoint{}, false
	}
	server := strings.TrimSpace(serverRaw)
	if server == "" {
		return "", config.DockerEndpoint{}, false
	}
	endpoint, declared := allowList.DockerEndpoints[server]
	if !declared {
		return "", config.DockerEndpoint{}, false
	}
	return server, endpoint, true
}

// 严格校验单容器查询：端点已声明且 server::container 已登记才放行。
// 未命中时返回 false，调用方不得创建客户端、不得发任何 Docker 请求。
func AuthorizeLookup(allowList *config.AllowList, serverRaw, containerRaw string) (Target, bool) {
	if allowList == nil {
		return Target{}, false
	}
	server := strings.TrimSpace(serverRaw)
	container := strings.TrimSpace(containerRaw)
	if server == "" || container == "" {
		return Target{}, false
	}

	endpoint, declared := allowList.DockerEndpoints[server]
	if !declared {
		return Target{}, false
	}
	if _, registered := allowList.DockerContainers[config.DockerContainerKey(server, container)]; !registered {
		return Target{}, false
	}
	return Target{Server: server, Container: container, Endpoint: endpoint}, true
}
