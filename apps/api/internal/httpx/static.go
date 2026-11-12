// Package httpx 托管前端静态产物：命中文件直接返回，未命中回退 index.html。
package httpx

import (
	"embed"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// 产物目录在编译期整体嵌入二进制。
// 该目录由 go generate 从 apps/web/dist 同步而来；未同步时仅剩占位文件，
// 构建照常通过，运行期一律 404。
//
//go:generate go run ./syncdist

//go:embed all:webdist
var embeddedDist embed.FS

// 嵌入根目录下的产物子目录名。
const distRoot = "webdist"

// 配置目录下参与静态映射的子目录，各自构成独立的 join 根。
// 前缀必须以尾斜杠结尾，裸前缀不视为资产路径。
const (
	imagesSubdir = "images"
	iconsSubdir  = "icons"

	imagesPrefix = "/" + imagesSubdir + "/"
	iconsPrefix  = "/" + iconsSubdir + "/"
)

// 带内容哈希的文件名可长期缓存，HTML 必须每次回源校验。
const (
	immutableCacheControl = "public, max-age=31536000, immutable"
	noCacheControl        = "no-cache"
)

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

// Static 是只读的产物托管器，可并发使用。
type Static struct {
	files fs.FS
	// 产物缺失时全部请求返回 404，不把占位内容当站点返回
	ready bool
	index []byte
	// 配置目录下的资产根；为空表示不参与映射，这些前缀按未命中处理
	imagesDir string
	iconsDir  string
}

// NewStatic 绑定编译期内嵌的前端产物快照。
func NewStatic() *Static {
	files, err := fs.Sub(embeddedDist, distRoot)
	if err != nil {
		return &Static{}
	}
	return newStatic(files)
}

// NewStaticForTest 用任意目录替代内嵌产物，供测试覆盖命中、回退与穿越拒绝。
func NewStaticForTest(files fs.FS) *Static {
	if files == nil {
		return &Static{}
	}
	return newStatic(files)
}

// NewStaticForConfig 在嵌入产物之外再映射配置目录下的两个资产根：
// images 子目录对应 /images/*，icons 子目录对应 /icons/*。
// 配置目录为空时不映射，这两个前缀与普通未命中路径一样回退到入口 HTML。
func NewStaticForConfig(configDir string) *Static {
	static := NewStatic()
	static.UseConfigAssets(configDir)
	return static
}

// UseConfigAssets 绑定配置目录下的两个资产根，重复调用以最后一次为准。
// 传空目录即取消映射。
func (s *Static) UseConfigAssets(configDir string) {
	dir := strings.TrimSpace(configDir)
	if dir == "" {
		s.imagesDir = ""
		s.iconsDir = ""
		return
	}
	s.imagesDir = filepath.Join(dir, imagesSubdir)
	s.iconsDir = filepath.Join(dir, iconsSubdir)
}

// 读取入口 HTML；缺失即视为产物未就绪。
func newStatic(files fs.FS) *Static {
	index, err := fs.ReadFile(files, "index.html")
	if err != nil {
		return &Static{files: files}
	}
	return &Static{files: files, ready: true, index: index}
}

// Ready 表示是否带上了完整前端产物。
func (s *Static) Ready() bool { return s.ready }

// ServeSPA 命中文件直接返回，未命中回退入口 HTML。
// 产物未就绪、路径非法或越出产物根时返回 404。
// /images/ 与 /icons/ 两个资产前缀不参与回退：文件不存在即 404，避免前端把 HTML 当图片解析。
func (s *Static) ServeSPA(w http.ResponseWriter, r *http.Request) {
	relative, ok := cleanRequestPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}

	// 资产根优先于内嵌产物：上传的图标要让配置里的 /images/... 引用立刻生效
	if rootDir, assetPath, matched := s.configAsset(r.URL.Path); matched {
		s.serveConfigAsset(w, r, rootDir, assetPath)
		return
	}

	if !s.ready {
		http.NotFound(w, r)
		return
	}
	if content, matched := s.lookup(relative); matched {
		writeAsset(w, relative, content)
		return
	}
	writeAsset(w, "index.html", s.index)
}

// ServeFile 只返回命中的产物文件，未命中即 404，供不接受回退的挂载点使用。
func (s *Static) ServeFile(w http.ResponseWriter, r *http.Request) {
	if !s.ready {
		http.NotFound(w, r)
		return
	}
	relative, ok := cleanRequestPath(r.URL.Path)
	if !ok || relative == "" {
		http.NotFound(w, r)
		return
	}
	content, matched := s.lookup(relative)
	if !matched {
		http.NotFound(w, r)
		return
	}
	writeAsset(w, relative, content)
}

// 取产物根内的相对路径对应内容；命中目录时取该目录下的 index.html。
func (s *Static) lookup(relative string) ([]byte, bool) {
	if relative == "" {
		return nil, false
	}
	name := relative
	if info, err := fs.Stat(s.files, name); err == nil && info.IsDir() {
		name = path.Join(name, "index.html")
	}
	content, err := fs.ReadFile(s.files, name)
	if err != nil {
		return nil, false
	}
	return content, true
}

// 把 URL 路径规整成产物根内的相对路径。
// ok=false 表示含 .. 段或清理后仍越出根，必须拒绝。
func cleanRequestPath(urlPath string) (string, bool) {
	trimmed := strings.TrimLeft(urlPath, "/")
	if trimmed == "" {
		return "", true
	}
	// 反斜杠在 Windows 上同样是分隔符，一并按段检查
	for _, segment := range strings.FieldsFunc(trimmed, isPathSeparator) {
		if segment == ".." {
			return "", false
		}
	}
	relative := strings.TrimPrefix(path.Clean("/"+trimmed), "/")
	// 清理后仍可能指向上级目录，二次确认不越出根
	if relative == ".." || strings.HasPrefix(relative, "../") {
		return "", false
	}
	return relative, true
}

func isPathSeparator(r rune) bool { return r == '/' || r == '\\' }

// configAsset 判断请求路径是否落在两个资产前缀下，并给出对应的 join 根与根内相对路径。
// 只认带尾斜杠的前缀：/images 本身不算资产路径，与产物路径同等处理。
func (s *Static) configAsset(urlPath string) (rootDir, assetPath string, matched bool) {
	switch {
	case s.imagesDir != "" && strings.HasPrefix(urlPath, imagesPrefix):
		return s.imagesDir, urlPath[len(imagesPrefix):], true
	case s.iconsDir != "" && strings.HasPrefix(urlPath, iconsPrefix):
		return s.iconsDir, urlPath[len(iconsPrefix):], true
	default:
		return "", "", false
	}
}

// serveConfigAsset 从资产根提供单个文件。
// join 根是各自子目录而非整个配置目录，路径解码失败、含 .. 或越出根时一律 404，
// 且不回退入口 HTML，让前端的图片加载直接失败而不是拿到一份 HTML。
func (s *Static) serveConfigAsset(w http.ResponseWriter, r *http.Request, rootDir, assetPath string) {
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

// 写出单个产物：缓存头按后缀决定，SVG 强制下载并全局禁用嗅探。
func writeAsset(w http.ResponseWriter, relative string, content []byte) {
	header := w.Header()
	header.Set("Content-Type", contentTypeFor(relative))
	header.Set("Cache-Control", cacheControlFor(relative))
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

// 入口 HTML 每次回源校验，其余产物按文件名带哈希处理，可长期缓存。
func cacheControlFor(relative string) string {
	if strings.EqualFold(path.Ext(relative), ".html") {
		return noCacheControl
	}
	return immutableCacheControl
}
