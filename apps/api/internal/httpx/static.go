// Package httpx 托管配置资产根：CONFIG_DIR 下的 images/icons 子目录映射为 /images /icons，提供只读静态文件服务。
package httpx

import (
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
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

// 标准库 mime 表缺的几种格式补登记；资产目录由本服务独占，补充项不影响其它使用方。
func init() {
	_ = mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8")
	_ = mime.AddExtensionType(".map", "application/json; charset=utf-8")
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json; charset=utf-8")
	_ = mime.AddExtensionType(".woff", "font/woff")
	_ = mime.AddExtensionType(".woff2", "font/woff2")
	_ = mime.AddExtensionType(".ttf", "font/ttf")
}

// Assets 是只读的配置资产托管器，可并发使用。
type Assets struct {
	// 两个资产 join 根；为空表示不参与映射，这些前缀一律 404
	images http.Handler
	icons  http.Handler
}

// NewAssets 映射配置目录下的两个资产根：images 子目录对应 /images/*，icons 子目录对应 /icons/*。
// 配置目录为空时不映射，两个前缀与未匹配路径一样返回 404。
func NewAssets(configDir string) *Assets {
	dir := strings.TrimSpace(configDir)
	if dir == "" {
		return &Assets{}
	}
	return &Assets{
		images: newAssetHandler(imagesPrefix, filepath.Join(dir, imagesSubdir)),
		icons:  newAssetHandler(iconsPrefix, filepath.Join(dir, iconsSubdir)),
	}
}

// ServeHTTP 提供两个资产前缀下的只读文件，未匹配前缀一律 404。
func (a *Assets) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case a.images != nil && strings.HasPrefix(r.URL.Path, imagesPrefix):
		a.images.ServeHTTP(w, r)
	case a.icons != nil && strings.HasPrefix(r.URL.Path, iconsPrefix):
		a.icons.ServeHTTP(w, r)
	default:
		http.NotFound(w, r)
	}
}

// newAssetHandler 把单个资产根接到标准库文件服务上。
// FileServerFS 负责路径清洗、穿越拒绝、HEAD、Range 与 index.html 回退；
// 这里只补三件事：剥掉路由前缀、目录不提供列表、统一缓存头与 SVG 按附件下发。
func newAssetHandler(prefix, root string) http.Handler {
	fsys := noListFS{inner: os.DirFS(root)}
	fileServer := http.StripPrefix(prefix, http.FileServerFS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("Cache-Control", immutableCacheControl)
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("Vary", "Accept-Encoding")
		// SVG 可内嵌脚本：按附件下载，避免被当作同源文档执行
		if strings.EqualFold(path.Ext(r.URL.Path), ".svg") {
			header.Set("Content-Disposition", "attachment")
		}
		fileServer.ServeHTTP(w, r)
	})
}

// noListFS 关闭目录列表：缺 index.html 的目录按不存在处理，存在则交给标准库回退到 index.html。
type noListFS struct {
	inner fs.FS
}

// Open 透传文件；打开的是目录时先确认其下有 index.html，否则按不存在返回。
func (f noListFS) Open(name string) (fs.File, error) {
	file, err := f.inner.Open(name)
	if err != nil {
		return nil, err
	}
	info, statErr := file.Stat()
	if statErr != nil {
		_ = file.Close()
		return nil, statErr
	}
	if !info.IsDir() {
		return file, nil
	}
	index, indexErr := f.inner.Open(path.Join(name, "index.html"))
	if indexErr != nil {
		_ = file.Close()
		return nil, fs.ErrNotExist
	}
	_ = index.Close()
	return file, nil
}
