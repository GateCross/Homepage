package routes

import (
	"net/http"
	"strings"

	"github.com/gatecross/homepage/api/internal/httpapi"
)

// 三个数据端点的路径前缀，末段为允许列表里的目标 ID。
const (
	// ProbePrefix 是站点探测的前缀。
	ProbePrefix = "/api/probe/"
	// WidgetsPrefix 是服务组件的前缀。
	WidgetsPrefix = "/api/widgets/"
	// InfoPrefix 是信息组件的前缀。
	InfoPrefix = "/api/info/"
)

// 按路径前缀把请求分派到探测、服务组件与信息组件。
// 每次请求只读当前快照里的允许列表，未登记的目标不会发起任何出站请求。
type Handler struct {
	deps Deps
}

// 创建处理器；未注入的能力在命中对应目标后按内部错误响应。
func NewHandler(deps Deps) *Handler {
	return &Handler{deps: deps}
}

// 只接受三个前缀下的单段路径；其它路径与非 GET 请求都回 JSON 404，不得回退到 SPA。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpapi.NotFound(msgAPINotFound).Write(w)
		return
	}

	if rawID, ok := cutSegment(r.URL.Path, ProbePrefix); ok {
		handleProbe(h.deps, w, r, rawID)
		return
	}
	if rawID, ok := cutSegment(r.URL.Path, WidgetsPrefix); ok {
		handleWidget(h.deps, w, r, rawID)
		return
	}
	if rawID, ok := cutSegment(r.URL.Path, InfoPrefix); ok {
		handleInfo(h.deps, w, r, rawID)
		return
	}
	httpapi.NotFound(msgAPINotFound).Write(w)
}

// 去掉前缀后必须恰好剩一段；多段与空段都不匹配。
func cutSegment(urlPath, prefix string) (string, bool) {
	rest, found := strings.CutPrefix(urlPath, prefix)
	if !found {
		return "", false
	}
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}
