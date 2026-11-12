// Package domain 定义与前端共享的 JSON 契约与稳定 ID 算法。
package domain

// StatusRange 是 HTTP 探测可接受的状态码闭区间。
type StatusRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// PublicError 是可安全外露的错误体，只含文案与配置定位。
type PublicError struct {
	Message string  `json:"message"`
	File    *string `json:"file,omitempty"`
	Path    *string `json:"path,omitempty"`
	Line    *int    `json:"line,omitempty"`
	Column  *int    `json:"column,omitempty"`
	Code    *string `json:"code,omitempty"`
}

// ErrorEnvelope 是失败响应信封，ok 恒为 false。
type ErrorEnvelope struct {
	Ok    bool        `json:"ok"`
	Error PublicError `json:"error"`
}

// 容器状态取值，与前端判别联合的 status 一致。
const (
	DockerStatusRunning     = "running"
	DockerStatusStarting    = "starting"
	DockerStatusRestarting  = "restarting"
	DockerStatusPaused      = "paused"
	DockerStatusStopped     = "stopped"
	DockerStatusUnavailable = "unavailable"
)

// 健康检查状态取值，仅配置了 HEALTHCHECK 的容器有值。
const (
	DockerHealthHealthy   = "healthy"
	DockerHealthUnhealthy = "unhealthy"
	DockerHealthStarting  = "starting"
)

// DockerResourceStats 是运行中容器的资源占用，缺省字段不出现在 JSON 中。
type DockerResourceStats struct {
	CPUPercent       *float64 `json:"cpuPercent,omitempty"`
	MemoryPercent    *float64 `json:"memoryPercent,omitempty"`
	MemoryUsageBytes *int64   `json:"memoryUsageBytes,omitempty"`
	MemoryLimitBytes *int64   `json:"memoryLimitBytes,omitempty"`
}

// DockerStatusResponse 是单容器状态；只有 running 会带资源字段与健康状态。
type DockerStatusResponse struct {
	Status string `json:"status"`

	DockerResourceStats

	Health *string `json:"health,omitempty"`
	Detail *string `json:"detail,omitempty"`
	Reason *string `json:"reason,omitempty"`
}

// 列表接口的容器状态取值，与前端契约一致；不在六种已知取值内的一律归为 other。
const (
	DockerListStateOther = "other"
)

// DockerContainerSummary 是容器列表里的单条摘要，不含 Env、Labels 与挂载等敏感字段。
type DockerContainerSummary struct {
	Name       string   `json:"name"`
	Image      *string  `json:"image,omitempty"`
	State      string   `json:"state"`
	Health     *string  `json:"health,omitempty"`
	StatusText *string  `json:"statusText,omitempty"`
	Ports      []string `json:"ports,omitempty"`
}

// DockerContainersResponse 是单个端点的容器列表响应体。
type DockerContainersResponse struct {
	Ok         bool                     `json:"ok"`
	Server     string                   `json:"server"`
	Containers []DockerContainerSummary `json:"containers"`
}

// DockerBatchItem 是批量结果里的单条已登记容器。
type DockerBatchItem struct {
	Server    string               `json:"server"`
	Container string               `json:"container"`
	Result    DockerStatusResponse `json:"result"`
}

// DockerBatchStatusResponse 是一次返回全部已登记容器状态的响应体。
type DockerBatchStatusResponse struct {
	Ok      bool              `json:"ok"`
	Results []DockerBatchItem `json:"results"`
}

// VersionResponse 是版本查询结果，远端检查相关字段可缺省。
type VersionResponse struct {
	Ok              bool    `json:"ok"`
	Version         string  `json:"version"`
	UpdateAvailable bool    `json:"updateAvailable"`
	LatestVersion   *string `json:"latestVersion,omitempty"`
	ReleaseURL      *string `json:"releaseUrl,omitempty"`
	CheckError      *bool   `json:"checkError,omitempty"`
}
