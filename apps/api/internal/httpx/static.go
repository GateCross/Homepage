// Package httpx 托管配置资产根：CONFIG_DIR 下的 images/icons 子目录映射为 /images /icons，提供只读静态文件服务。
package httpx

import (
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// 配置目录下参与静态映射的子目录，各自构成独立的 join 根。
// 前缀必须以尾斜杠结尾，裸前缀不视为资产路径。
const (
	imagesSubdir = "images"
	iconsSubdir  = "icons"

	imagesPrefix = "/" + imagesSubdir + "/"
	iconsPrefix  = "/" + iconsSubdir + "/"
)

// 资产内容生成后不再变化，可长期缓存。
const immutableCacheControl = "public, max-age=31536000, immutable"

// 后缀到 MIME 的映射，未命中的后缀按二进制流返回。
var mimeByExt = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".map":         "application/json; charset=utf-8",
	".txt":         "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".gif":         "image/gif",
	".webp":        "image/webp",
	".ico":         "image/x-icon",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
}

// Assets 是只读的配置资产托管器，可并发使用。
type Assets struct {
	// 两个资产 join 根；为空表示不参与映射，这些前缀一律 404
	imagesDir string
	iconsDir  string
}

// NewAssets 映射配置目录下的两个资产根：images 子目录对应 /images/*，icons 子目录对应 /icons/*。
// 配置目录为空时不映射，两个前缀与未匹配路径一样返回 404。
func NewAssets(configDir string) *Assets {
	assets := &Assets{}
	dir := strings.TrimSpace(configDir)
	if dir == "" {
		return assets
	}
	assets.imagesDir = filepath.Join(dir, imagesSubdir)
	assets.iconsDir = filepath.Join(dir, iconsSubdir)
	return assets
}

// Serve 提供两个资产前缀下的只读文件，未匹配前缀一律 404。
// 文件缺失、路径非法或越出根时同样 404，不回退任何 HTML，
// 让前端的图片加载直接失败而不是拿到一份 HTML。
func (a *Assets) Serve(w http.ResponseWriter, r *http.Request) {
	rootDir, assetPath, matched := a.configAsset(r.URL.Path)
	if !matched {
		http.NotFound(w, r)
		return
	}
	serveConfigAsset(w, r, rootDir, assetPath)
}

// ServeHTTP 让 *Assets 直接满足 http.Handler，便于挂到 ServeMux 上。
func (a *Assets) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.Serve(w, r)
}

// configAsset 判断请求路径是否落在两个资产前缀下，并给出对应的 join 根与根内相对路径。
// 只认带尾斜杠的前缀：/images 本身不算资产路径。
func (a *Assets) configAsset(urlPath string) (rootDir, assetPath string, matched bool) {
	switch {
	case a.imagesDir != "" && strings.HasPrefix(urlPath, imagesPrefix):
		return a.imagesDir, urlPath[len(imagesPrefix):], true
	case a.iconsDir != "" && strings.HasPrefix(urlPath, iconsPrefix):
		return a.iconsDir, urlPath[len(iconsPrefix):], true
	default:
		return "", "", false
	}
}

// serveConfigAsset 从资产根提供单个文件。
// join 根是各自子目录而非整个配置目录，路径解码失败、含 .. 或越出根时一律 404。
func serveConfigAsset(w http.ResponseWriter, r *http.Request, rootDir, assetPath string) {
	target, ok := joinUnderRoot(rootDir, assetPath)
	if !ok {
		http.NotFound(w, r)
		return
	}

	info, err := os.Stat(target)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if info.IsDir() {
		// 目录按该目录下的 index.html 处理，缺失即 404
		target = filepath.Join(target, "index.html")
		if nested, statErr := os.Stat(target); statErr != nil || !nested.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
	} else if !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}

	content, err := os.ReadFile(target)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// 后缀判定按正斜杠处理，Windows 上层目录名带点时才不会被误当扩展名
	writeAsset(w, filepath.ToSlash(target), content)
}

// 把请求给出的相对路径解到资产根内。
// 先按 URL 转义解码，任一段为 .. 即拒绝；解析后仍须落在根内，否则同样拒绝。
// 空相对路径解为根目录本身，由调用方按目录规则处理。
func joinUnderRoot(rootDir, assetPath string) (string, bool) {
	relative := strings.TrimLeft(assetPath, "/")
	// 请求路径可能已被上层解码，这里再解一次；转义残缺按非法路径拒绝
	decoded, err := url.PathUnescape(relative)
	if err != nil {
		return "", false
	}
	relative = decoded
	// 反斜杠在 Windows 上同样是分隔符，一并按段检查
	for _, segment := range strings.FieldsFunc(relative, isPathSeparator) {
		if segment == ".." {
			return "", false
		}
	}

	root, err := filepath.Abs(rootDir)
	if err != nil {
		return "", false
	}
	target, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return "", false
	}
	if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", false
	}
	return target, true
}

func isPathSeparator(r rune) bool { return r == '/' || r == '\\' }

// 写出单个资产：统一长缓存，SVG 强制下载并全局禁用嗅探。
func writeAsset(w http.ResponseWriter, relative string, content []byte) {
	header := w.Header()
	header.Set("Content-Type", contentTypeFor(relative))
	header.Set("Cache-Control", cacheControlFor())
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Vary", "Accept-Encoding")
	// SVG 可内嵌脚本：按附件下载，避免被当作同源文档执行
	if strings.EqualFold(path.Ext(relative), ".svg") {
		header.Set("Content-Disposition", "attachment")
	}
	header.Set("Content-Length", strconv.Itoa(len(content)))
	// 标准库对 HEAD 请求会自行丢弃响应体，这里无需区分方法
	_, _ = w.Write(content)
}

// 后缀决定 MIME。
func contentTypeFor(relative string) string {
	if mime, ok := mimeByExt[strings.ToLower(path.Ext(relative))]; ok {
		return mime
	}
	return "application/octet-stream"
}

// 资产中不再有 HTML，统一按不可变资源长期缓存。
func cacheControlFor() string {
	return immutableCacheControl
}
