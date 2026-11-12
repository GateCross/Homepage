package httpapi

import (
	"net/http"
	"strings"

	"github.com/gatecross/homepage/api/internal/httpx"
)

// Mounts 是调用方注入的挂载点；为 nil 的前缀一律按 JSON 404 响应。
type Mounts struct {
	// Docker 处理 /api/docker/ 下的批量、列表与单容器端点
	Docker http.Handler
	// Config 处理 /api/config 与 /api/config/editable，写回只接受 PUT
	Config http.Handler
	// Assets 处理 /api/assets/upload
	Assets http.Handler
	// Icons 处理 /api/icons/resolve 与 /api/icons/import
	Icons http.Handler
	// Data 处理 /api/probe/:probeId、/api/widgets/:widgetId 与 /api/info/:infoId
	Data http.Handler
}

// Options 是路由组装的输入。
type Options struct {
	Mounts Mounts
	// Static 为 nil 时使用内嵌产物；非 /api 路径全部走它
	Static *httpx.Static
}

// 组装路由与中间件。
// 中间件顺序：panic 恢复在最外，其次请求日志，gzip 最内贴近业务。
func NewRouter(options Options) http.Handler {
	static := options.Static
	if static == nil {
		static = httpx.NewStatic()
	}

	mux := http.NewServeMux()
	registerAPI(mux, options.Mounts)

	// 未匹配的 /api 路径返回 JSON；其余交给静态托管
	mux.Handle("/", notFoundHandler{static: static})

	return Chain(mux, RecoverPanics, LogRequests, Gzip)
}

// 全部 API 端点在此登记；方法写进模式里，其它方法自然落到 404。
// Go 1.22+ 的模式优先级按具体度判定，静态段优先于通配段，
// 因此 /api/docker/status 不会被 /api/docker/:server/:container 吃掉。
func registerAPI(mux *http.ServeMux, mounts Mounts) {
	mux.HandleFunc("GET /api/health", handleHealth)
	mux.HandleFunc("GET /api/version", handleVersion)

	if mounts.Config != nil {
		mux.Handle("GET /api/config", mounts.Config)
		mux.Handle("GET /api/config/editable", mounts.Config)
		// 写回是唯一会改磁盘的路径，方法单独注册
		mux.Handle("PUT /api/config", mounts.Config)
	}
	if mounts.Assets != nil {
		mux.Handle("POST /api/assets/upload", mounts.Assets)
	}
	if mounts.Icons != nil {
		mux.Handle("POST /api/icons/resolve", mounts.Icons)
		mux.Handle("POST /api/icons/import", mounts.Icons)
	}
	if mounts.Data != nil {
		mux.Handle("GET /api/probe/{probeId}", mounts.Data)
		mux.Handle("GET /api/widgets/{widgetId}", mounts.Data)
		mux.Handle("GET /api/info/{infoId}", mounts.Data)
	}
	if mounts.Docker != nil {
		// 批量与列表路径都是静态段，优先级高于后面的单容器通配段
		mux.Handle("GET /api/docker/status", mounts.Docker)
		mux.Handle("GET /api/docker/status.json", mounts.Docker)
		mux.Handle("GET /api/docker/{server}/containers", mounts.Docker)
		mux.Handle("GET /api/docker/{server}/{container}", mounts.Docker)
		// 未登记的子路径与非常规方法统一回 JSON 404，而不是回退到 SPA
		mux.Handle("/api/docker/", mounts.Docker)
	}
}

// 健康检查只表明进程存活，不读取配置也不探测外部依赖。
func handleHealth(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "@homepage/api"})
}

// notFoundHandler 兜住所有未匹配路径。
// /api 前缀必须先于静态托管处理：API 路径不得回退到 SPA，否则前端拿到 HTML 解析失败。
// 路径已注册但方法不匹配时，标准库在进入这里之前就会返回 405。
type notFoundHandler struct {
	static *httpx.Static
}

func (h notFoundHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if isAPIPath(r.URL.Path) {
		WriteError(w, NotFound("未找到请求的 API 接口"))
		return
	}
	h.static.ServeSPA(w, r)
}

// 是否属于 /api 命名空间；/apix 之类的相似前缀不算。
func isAPIPath(urlPath string) bool {
	return urlPath == "/api" || strings.HasPrefix(urlPath, "/api/")
}
