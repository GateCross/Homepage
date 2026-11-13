package config

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/gatecross/homepage/api/internal/httpapi"
)

// 两个配置读取端点。
const (
	// ConfigPath 输出规范化配置，对齐前端 ConfigSuccessResponse 契约。
	ConfigPath = "/api/config"
	// ConfigEditablePath 输出可编辑视图，密钥只给状态。
	ConfigEditablePath = "/api/config/editable"
)

// 固定中文错误文案，均不含任何敏感内容。
const (
	configLeakMessage   = "配置安全校验失败，请检查服务端配置"
	configBrokenMessage = "配置读取失败，请稍后重试"
)

// 连接串含内嵌凭据的错误码，取值与前端契约一致；状态码 422 由调用处显式指定。
const codeDockerConnectionSensitive = "DOCKER_CONNECTION_SENSITIVE"

// 配置故障态错误码，取值与前端契约一致；状态码 500 由调用处显式指定。
const codeConfigFaulted = "CONFIG_FAULTED"

// Handler 提供 /api/config 下的读写端点。
// 读端点只取 Store 的当前快照，不读盘；写端点才会碰磁盘，且持写锁完成整份替换。
type Handler struct {
	store *Store
	// 写回目标目录；为空时写回一律按内部失败拒绝
	configDirPath string
}

// 创建处理器；store 为 nil 时一律按空快照响应。
func NewHandler(store *Store) *Handler {
	return &Handler{store: store}
}

// WithConfigDir 设置写回目标目录，返回自身以便链式装配。
// 未设置目录的处理器只提供读取，写回按内部失败拒绝。
func (h *Handler) WithConfigDir(dir string) *Handler {
	h.configDirPath = dir
	return h
}

// 把 /api/config 下的请求分派到各端点，方法独立判断。
// 其它子路径本切片未实现，按 API 契约返回 JSON 404，不得回退到 SPA。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case ConfigPath:
		if r.Method == http.MethodPut {
			h.ServeConfigWrite(w, r)
			return
		}
		h.ServeConfig(w, r)
	case ConfigEditablePath:
		h.ServeEditable(w, r)
	default:
		httpapi.NotFound("未找到请求的 API 接口").Write(w)
	}
}

// 输出规范化配置；序列化后先做密钥扫描，命中则改回 Internal 信封而不下发。
func (h *Handler) ServeConfig(w http.ResponseWriter, _ *http.Request) {
	snapshot := h.snapshot()
	payload, err := json.Marshal(snapshot.Config)
	if err != nil {
		writeInternalError(w)
		return
	}
	if containsSecret(payload, snapshot.AllowList) {
		log.Printf("配置响应疑似包含敏感值，已拒绝下发")
		httpapi.Internal(configLeakMessage).Write(w)
		return
	}
	httpapi.WriteJSONBytes(w, http.StatusOK, payload)
}

// 输出可编辑视图；投影失败按配置无效处理，命中密钥同样不下发。
func (h *Handler) ServeEditable(w http.ResponseWriter, _ *http.Request) {
	snapshot := h.snapshot()
	editable, err := BuildEditableConfig(snapshot)
	if err != nil {
		var configErr *EditableConfigError
		if errors.As(err, &configErr) {
			httpapiErrorFor(configErr).Write(w)
			return
		}
		writeInternalError(w)
		return
	}

	payload, err := json.Marshal(editable)
	if err != nil {
		writeInternalError(w)
		return
	}
	if containsSecret(payload, snapshot.AllowList) {
		log.Printf("可编辑配置响应疑似包含敏感值，已拒绝下发")
		httpapi.Internal(configLeakMessage).Write(w)
		return
	}
	httpapi.WriteJSONBytes(w, http.StatusOK, payload)
}

// 当前快照；未注入 Store 时返回空快照，读取方无需判空。
func (h *Handler) snapshot() *Snapshot {
	if h.store == nil {
		return emptySnapshot()
	}
	return h.store.Snapshot()
}

// 序列化后的响应是否含允许列表中的敏感值；空列表直接放行。
func containsSecret(payload []byte, allowList *AllowList) bool {
	secrets := CollectSensitiveValues(allowList)
	if len(secrets) == 0 {
		return false
	}
	return JSONContainsAnySecret(payload, secrets)
}

// 配置失败转成失败信封：内嵌凭据与故障态各有专用错误码，其余配置问题按 CONFIG_INVALID 处理。
func httpapiErrorFor(configErr *EditableConfigError) *httpapi.Error {
	var apiErr *httpapi.Error
	switch configErr.Code {
	case codeDockerConnectionSensitive:
		apiErr = httpapi.NewError(configErr.Code, configErr.Message)
		apiErr.Status = http.StatusUnprocessableEntity
	case codeConfigFaulted:
		// 故障态固定 500，与前端契约的状态码映射一致
		apiErr = httpapi.NewError(configErr.Code, configErr.Message)
		apiErr.Status = http.StatusInternalServerError
	default:
		apiErr = httpapi.ConfigInvalid(configErr.Message)
	}
	if configErr.File != "" {
		apiErr = apiErr.WithFile(configErr.File)
	}
	if configErr.Path != "" {
		apiErr = apiErr.WithPath(configErr.Path)
	}
	return apiErr
}

// 未预期的内部失败统一回落到固定文案，不暴露细节。
func writeInternalError(w http.ResponseWriter) {
	httpapi.Internal(configBrokenMessage).Write(w)
}
