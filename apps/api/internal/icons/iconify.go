package icons

import (
	"context"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gatecross/homepage/api/internal/httpapi"
)

// Iconify 代理常量。前端用 `mdi-*` / `si-*` 写图标标识，浏览器不直连 CDN，
// 由本站转发，离线或被网络阻断时前端仍能拿到 SVG。
const (
	// IconifyProxyPrefix 是上游图标源。
	IconifyProxyPrefix = "https://api.iconify.design"
	// 代理超时远短于页面抓取：单个图标失败不应拖住首屏。
	iconifyTimeout = 10 * time.Second
	// 单个 SVG 上限 256 KiB，超限按出站失败处理。
	iconifyMaxBytes int64 = 256 * 1024
	// 图标名以字母或数字开头，其后可含连字符；不含路径分隔符。
	iconifyNamePattern = `^[a-zA-Z0-9][a-zA-Z0-9-]*$`
)

// 固定失败文案，可直接下发浏览器。
const (
	msgIconifyUnsupportedSet = "不支持的图标集"
	msgIconifyInvalidName    = "图标名称无效"
	msgIconifyNotFound       = "图标不存在"
	msgIconifyTimeout        = "图标源请求超时"
	msgIconifyUnreachable    = "无法连接图标源"
	msgIconifyBadStatus      = "图标源返回异常状态"
	msgIconifyTooLarge       = "图标源响应体积超过限制"
	msgIconifyFailed         = "获取图标失败，请稍后重试"
)

// 允许的图标集：与前端 icons.ts 的 mdi/si 两种 kind 一一对应。
var iconifyAllowedPrefixes = map[string]struct{}{
	"mdi":          {},
	"simple-icons": {},
}

var iconifyNameRE = regexp.MustCompile(iconifyNamePattern)

// 代理用的出站客户端：不忽略证书错误（CDN 是公网可信目标），单次只发一个请求。
var iconifyClient = &http.Client{Timeout: iconifyTimeout}

// IconifyHandler 处理 GET /api/icons/iconify/{prefix}/{name} 的 CDN 代理。
type IconifyHandler struct{}

// NewIconifyHandler 创建代理处理器；无状态，可并发使用。
func NewIconifyHandler() *IconifyHandler { return &IconifyHandler{} }

// 上游 404 映射 404，超时 504，其余出站异常 502；成功响应带一天缓存。
func (*IconifyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpapi.NotFound(msgAPINotFound).Write(w)
		return
	}

	prefix := strings.ToLower(strings.TrimSpace(r.PathValue("prefix")))
	name := strings.TrimSpace(r.PathValue("name"))
	// 前端带 .svg 后缀，去掉后作为图标名
	if lower := strings.ToLower(name); strings.HasSuffix(lower, ".svg") {
		name = name[:len(name)-len(".svg")]
	}

	if _, allowed := iconifyAllowedPrefixes[prefix]; !allowed {
		httpapi.NotFound(msgIconifyUnsupportedSet).Write(w)
		return
	}
	if !iconifyNameRE.MatchString(name) {
		httpapi.ConfigInvalid(msgIconifyInvalidName).Write(w)
		return
	}

	upstream := IconifyProxyPrefix + "/" + prefix + "/" + name + ".svg"
	body, failure := fetchIconify(r.Context(), upstream)
	if failure != nil {
		writeIconifyFailure(w, failure)
		return
	}

	header := w.Header()
	header.Set("Content-Type", "image/svg+xml; charset=utf-8")
	header.Set("Cache-Control", "public, max-age=86400")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Disposition", "attachment")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// iconifyFailure 是代理失败的分类，决定状态码与文案。
type iconifyFailure struct {
	status  int
	code    string
	message string
}

// 拉取上游 SVG；体积上限在读取时强制，避免无界缓冲。
func fetchIconify(ctx context.Context, upstream string) ([]byte, *iconifyFailure) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, upstream, nil)
	if err != nil {
		return nil, &iconifyFailure{http.StatusBadGateway, httpapi.CodeExternal, msgIconifyBadStatus}
	}
	request.Header.Set("Accept", "image/svg+xml,*/*")
	request.Header.Set("User-Agent", "Homepage-Iconify-Proxy/1.0")

	response, err := iconifyClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &iconifyFailure{http.StatusGatewayTimeout, httpapi.CodeExternalTmo, msgIconifyTimeout}
		}
		return nil, &iconifyFailure{http.StatusBadGateway, httpapi.CodeExternal, msgIconifyUnreachable}
	}
	defer func() { _ = response.Body.Close() }()

	if response.StatusCode == http.StatusNotFound {
		return nil, &iconifyFailure{http.StatusNotFound, httpapi.CodeNotFound, msgIconifyNotFound}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &iconifyFailure{http.StatusBadGateway, httpapi.CodeExternal, msgIconifyBadStatus}
	}

	// 多读一个字节即可判定超限，之后不再续读
	body, err := io.ReadAll(io.LimitReader(response.Body, iconifyMaxBytes+1))
	if err != nil {
		return nil, &iconifyFailure{http.StatusBadGateway, httpapi.CodeExternal, msgIconifyUnreachable}
	}
	if int64(len(body)) > iconifyMaxBytes {
		return nil, &iconifyFailure{http.StatusBadGateway, httpapi.CodeExternal, msgIconifyTooLarge}
	}
	return body, nil
}

// 失败按分类输出统一信封；未分类走内部错误与固定提示。
func writeIconifyFailure(w http.ResponseWriter, failure *iconifyFailure) {
	httpapi.NewError(failure.code, failure.message).Write(w)
}
