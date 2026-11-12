package icons

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"github.com/gatecross/homepage/api/internal/httpapi"
)

// 两个控制面端点，只响应 POST。
const (
	// ResolvePath 解析图标，响应内嵌候选预览。
	ResolvePath = "/api/icons/resolve"
	// ImportPath 把选中的候选写入 images 目录。
	ImportPath = "/api/icons/import"
)

// 请求体大小上限：两个端点的载荷都只有短字符串。
const maxRequestBodyBytes = 64 * 1024

// 固定失败文案，不含内部细节。
const (
	msgBodyNotJSON   = "请求体必须为 JSON"
	msgResolveFailed = "解析站点图标失败，请稍后重试"
	msgImportFailed  = "导入站点图标失败，请稍后重试"
	msgAPINotFound   = "未找到请求的 API 接口"
)

// Resolve 的入参，url 缺省时按无效地址处理。
type resolveRequest struct {
	URL string `json:"url"`
}

// Import 的入参，两个标识都必须给出。
type importRequest struct {
	SessionID   string `json:"sessionId"`
	CandidateID string `json:"candidateId"`
}

// 负责两个图标端点的解包、错误码映射与响应输出。
type Handler struct {
	service *Service
}

// 创建处理器；service 为 nil 时按服务不可用响应。
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// 处理两个固定路径；其它子路径与非 POST 请求都回 JSON 404，不得回退到 SPA。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpapi.NotFound(msgAPINotFound).Write(w)
		return
	}
	switch r.URL.Path {
	case ResolvePath:
		h.serveResolve(w, r)
	case ImportPath:
		h.serveImport(w, r)
	default:
		httpapi.NotFound(msgAPINotFound).Write(w)
	}
}

// 解析图标：请求体不是 JSON 按配置无效处理，服务失败按分类映射错误码。
func (h *Handler) serveResolve(w http.ResponseWriter, r *http.Request) {
	var body resolveRequest
	if err := decodeJSONBody(r, &body); err != nil {
		httpapi.ConfigInvalid(msgBodyNotJSON).Write(w)
		return
	}
	if h.service == nil {
		httpapi.Internal(msgResolveFailed).Write(w)
		return
	}

	resolved, serviceErr := h.service.Resolve(r.Context(), body.URL)
	if serviceErr != nil {
		writeServiceError(w, msgResolveFailed, serviceErr)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, resolved)
}

// 导入图标：请求体非法按配置无效处理，服务失败按分类映射，写入失败是内部错误。
func (h *Handler) serveImport(w http.ResponseWriter, r *http.Request) {
	var body importRequest
	if err := decodeJSONBody(r, &body); err != nil {
		httpapi.ConfigInvalid(msgBodyNotJSON).Write(w)
		return
	}
	if h.service == nil {
		httpapi.Internal(msgImportFailed).Write(w)
		return
	}

	imported, serviceErr := h.service.Import(body.SessionID, body.CandidateID)
	if serviceErr != nil {
		writeServiceError(w, msgImportFailed, serviceErr)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, imported)
}

// 读取 JSON 请求体：限制体积，并拒绝在同一请求体里出现第二个 JSON 值。
func decodeJSONBody(r *http.Request, target any) error {
	if r.Body == nil {
		return errors.New("请求体为空")
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxRequestBodyBytes))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return errors.New("请求体含多余内容")
	}
	return nil
}

// 失败分类到错误码的映射与 TS 路由逐条一致：
// 地址无效与无候选是 422，超时 504，其余出站失败 502，会话与候选缺失 404，写入失败 500。
// 未分类的失败按内部错误外露，文案用调用处的固定提示，分类只进日志。
func writeServiceError(w http.ResponseWriter, fallback string, serviceErr *ServiceError) {
	switch serviceErr.Code {
	case CodeInvalidURL, CodeNoCandidates:
		httpapi.ConfigInvalid(serviceErr.Message).Write(w)
	case CodeTimeout:
		httpapi.NewError(httpapi.CodeExternalTmo, serviceErr.Message).Write(w)
	case CodeExternal:
		httpapi.NewError(httpapi.CodeExternal, serviceErr.Message).Write(w)
	case CodeSessionExpired, CodeCandidateMissing:
		httpapi.NotFound(serviceErr.Message).Write(w)
	case CodeWriteFailed:
		httpapi.Internal(serviceErr.Message).Write(w)
	default:
		log.Printf("图标端点遇到未分类的失败：%s，文案改用固定提示", serviceErr.Code)
		httpapi.Internal(fallback).Write(w)
	}
}
