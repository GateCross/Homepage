// Package config 负责读取五份 YAML、构建服务端允许列表，并对外提供可原子替换的快照。
package config

import (
	"strconv"
	"strings"
	"unicode"

	"github.com/gatecross/homepage/api/internal/domain"
)

// 端点类型：unix 走本地 socket，tcp 走 host/port。
const (
	DockerEndpointUnix = "unix"
	DockerEndpointTCP  = "tcp"
)

// DockerEndpoint 是 docker.yaml 中一个已解析的连接目标。
// Kind 为 unix 时只用 SocketPath；为 tcp 时只用 Host、Port 与 TLS。
type DockerEndpoint struct {
	Kind       string
	SocketPath string
	Host       string
	Port       int
	TLS        bool
}

// HTTPProbeTarget 是当次允许探测的服务端目标；URL 与超时不进入浏览器视图。
type HTTPProbeTarget struct {
	URL            string
	ExpectedStatus []domain.StatusRange
	TimeoutMs      int
}

// WidgetTarget 是服务组件的出站目标，secrets 为插值后的密钥明文。
type WidgetTarget struct {
	Type    string
	URL     string
	Secrets map[string]string
	Options any
}

// InfoTarget 是信息组件的服务端目标，options 按类型承载城市编码或磁盘路径。
type InfoTarget struct {
	Type    string
	Options any
}

// AllowList 是当次配置加载产生的授权集合，只存在于服务端。
// 空值表示未授权；读取方不得缓存为跨请求的全局真相。
type AllowList struct {
	HTTPProbeTargets map[string]HTTPProbeTarget
	WidgetTargets    map[string]WidgetTarget
	InfoTargets      map[string]InfoTarget
	DockerEndpoints  map[string]DockerEndpoint
	DockerContainers map[string]struct{}
}

// NewAllowList 构造空的允许列表。
func NewAllowList() *AllowList {
	return &AllowList{
		HTTPProbeTargets: make(map[string]HTTPProbeTarget),
		WidgetTargets:    make(map[string]WidgetTarget),
		InfoTargets:      make(map[string]InfoTarget),
		DockerEndpoints:  make(map[string]DockerEndpoint),
		DockerContainers: make(map[string]struct{}),
	}
}

// DockerContainerKey 生成容器登记键；键格式固定为 server::container。
func DockerContainerKey(server, container string) string {
	return server + "::" + container
}

// ParseDockerEndpoint 解析 unix:///path、tcp://host:port、https://host:port 三种写法；
// 其它形式、非法端口或内嵌路径一律返回 false。
func ParseDockerEndpoint(raw string) (DockerEndpoint, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return DockerEndpoint{}, false
	}
	lower := strings.ToLower(trimmed)

	if strings.HasPrefix(lower, "unix://") {
		socketPath := trimmed[len("unix://"):]
		if !validUnixSocketPath(socketPath) {
			return DockerEndpoint{}, false
		}
		return DockerEndpoint{Kind: DockerEndpointUnix, SocketPath: socketPath}, true
	}
	if strings.HasPrefix(lower, "tcp://") {
		return parseTCPEndpoint(trimmed[len("tcp://"):], false)
	}
	if strings.HasPrefix(lower, "https://") {
		return parseTCPEndpoint(trimmed[len("https://"):], true)
	}
	return DockerEndpoint{}, false
}

func validUnixSocketPath(socketPath string) bool {
	return socketPath != "" &&
		socketPath != "/" &&
		strings.HasPrefix(socketPath, "/") &&
		!strings.ContainsRune(socketPath, 0)
}

// 解析 authority 部分；host 中不允许出现路径或空白，端口须为 1–65535。
func parseTCPEndpoint(authority string, tls bool) (DockerEndpoint, bool) {
	trimmed := strings.TrimSpace(authority)
	if trimmed == "" {
		return DockerEndpoint{}, false
	}
	// 丢弃 path/query/fragment，例如 https://host:2376/version
	if cut := strings.IndexAny(trimmed, "/?#"); cut >= 0 {
		trimmed = trimmed[:cut]
	}

	var host, portText string
	if strings.HasPrefix(trimmed, "[") {
		closeIdx := strings.Index(trimmed, "]")
		if closeIdx <= 1 {
			return DockerEndpoint{}, false
		}
		host = trimmed[1:closeIdx]
		rest := trimmed[closeIdx+1:]
		if !strings.HasPrefix(rest, ":") {
			return DockerEndpoint{}, false
		}
		portText = rest[1:]
	} else {
		colon := strings.LastIndex(trimmed, ":")
		if colon <= 0 || colon == len(trimmed)-1 {
			return DockerEndpoint{}, false
		}
		host = trimmed[:colon]
		portText = trimmed[colon+1:]
	}

	if host == "" || strings.Contains(host, "/") {
		return DockerEndpoint{}, false
	}
	for _, r := range host {
		if unicode.IsSpace(r) {
			return DockerEndpoint{}, false
		}
	}

	// 端口只接受纯数字，符号与空白都不合法
	for _, r := range portText {
		if r < '0' || r > '9' {
			return DockerEndpoint{}, false
		}
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return DockerEndpoint{}, false
	}

	return DockerEndpoint{Kind: DockerEndpointTCP, Host: host, Port: port, TLS: tls}, true
}
