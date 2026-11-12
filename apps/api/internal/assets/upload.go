// Package assets 实现图片上传：字段核对、类型与魔数校验，并落盘到配置目录的 images 子目录。
package assets

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gatecross/homepage/api/internal/httpapi"
)

// UploadPath 是资源上传端点。
const UploadPath = "/api/assets/upload"

// MaxUploadBytes 是单张图片的字节上限。
const MaxUploadBytes = 5 * 1024 * 1024

// uploadOverhead 是 multipart 分隔符与分段头的额外开销余量，不计入图片体积。
const uploadOverhead = 64 * 1024

// 文件名规则：清洗后的原名，加时间戳与随机尾缀，避免并发上传互相覆盖。
const (
	filenameFallback = "image"
	filenameMaxBase  = 48
	filenameRandSize = 4
)

// 固定中文文案，均不含内部细节。
const (
	msgAPINotFound      = "未找到请求的 API 接口"
	msgMultipartOnly    = "请求必须为 multipart/form-data"
	msgFileFieldMissing = "请选择要上传的图片文件（字段名 file）"
	msgEmptyFile        = "上传文件为空"
	msgTooLarge         = "图片不能超过 5MB"
	msgUnsupportedType  = "仅支持 jpg、png、webp、gif、svg、ico 图片"
	msgContentMismatch  = "文件内容与图片类型不匹配"
	msgPathRejected     = "资源路径校验失败"
	msgWriteDenied      = "上传图片失败：配置目录无写权限，请检查 Docker 挂载的 config/images 权限"
	msgWriteFailed      = "上传图片失败，请稍后重试"
)

// 分段声明的 MIME 到落盘扩展名，一致的类型归一到同一后缀。
var extByContentType = map[string]string{
	"image/jpeg":               ".jpg",
	"image/png":                ".png",
	"image/webp":               ".webp",
	"image/gif":                ".gif",
	"image/svg+xml":            ".svg",
	"image/x-icon":             ".ico",
	"image/vnd.microsoft.icon": ".ico",
}

// 原文件名后缀到落盘扩展名；声明 MIME 缺失或不在白名单时按它兜底。
var extBySuffix = map[string]string{
	".jpg":  ".jpg",
	".jpeg": ".jpg",
	".png":  ".png",
	".webp": ".webp",
	".gif":  ".gif",
	".svg":  ".svg",
	".ico":  ".ico",
}

// UploadResponse 是上传成功体，字段名与前端契约逐字一致。
type UploadResponse struct {
	Ok       bool   `json:"ok"`
	Path     string `json:"path"`
	Filename string `json:"filename"`
}

// Handler 处理资源上传；图片一律落盘到配置目录的 images 子目录。
type Handler struct {
	configDir string
}

// NewHandler 创建上传处理器；配置目录为空时回落到环境变量，两者都为空则全部请求按内部错误响应。
func NewHandler(configDir string) *Handler {
	dir := strings.TrimSpace(configDir)
	if dir == "" {
		dir = strings.TrimSpace(os.Getenv("CONFIG_DIR"))
	}
	return &Handler{configDir: dir}
}

// ServeHTTP 只接受 POST /api/assets/upload；其它路径与非 POST 请求回 JSON 404，不回退到 SPA。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != UploadPath || r.Method != http.MethodPost {
		httpapi.NotFound(msgAPINotFound).Write(w)
		return
	}
	h.serveUpload(w, r)
}

// 解析 multipart 并落盘：字段与内容校验失败回 422，读写磁盘失败回 500。
func (h *Handler) serveUpload(w http.ResponseWriter, r *http.Request) {
	// 声明长度明显超限时不解析请求体；分块传输仍由下面的读取上限兜住
	if declaredTooLarge(r) {
		httpapi.ConfigInvalid(msgTooLarge).Write(w)
		return
	}

	reader, err := r.MultipartReader()
	if err != nil {
		httpapi.ConfigInvalid(msgMultipartOnly).Write(w)
		return
	}
	input, message := readFilePart(reader)
	if message != "" {
		httpapi.ConfigInvalid(message).Write(w)
		return
	}

	ext, ok := resolveExtension(input.contentType, input.name)
	if !ok {
		httpapi.ConfigInvalid(msgUnsupportedType).Write(w)
		return
	}
	if !magicMatches(ext, input.body) {
		httpapi.ConfigInvalid(msgContentMismatch).Write(w)
		return
	}
	if h.configDir == "" {
		httpapi.Internal(msgWriteFailed).Write(w)
		return
	}

	imagesDir := filepath.Join(h.configDir, "images")
	if err := os.MkdirAll(imagesDir, 0o755); err != nil {
		writeUploadFailure(w, err)
		return
	}

	filename := newFilename(input.name, ext)
	target := filepath.Join(imagesDir, filename)
	// 清洗后的名字仍须直接落在 images 目录内
	if !withinDir(imagesDir, target) {
		httpapi.Internal(msgPathRejected).Write(w)
		return
	}
	if err := os.WriteFile(target, input.body, 0o644); err != nil {
		writeUploadFailure(w, err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, UploadResponse{
		Ok:       true,
		Path:     "/images/" + filename,
		Filename: filename,
	})
}

// 从请求体取出的待落盘图片：原始文件名、分段声明的 MIME 与完整字节。
type uploadedInput struct {
	name        string
	contentType string
	body        []byte
}

// 取 file 字段：多于上限一个字节即判定超限，字段缺失或分段损坏都给出对应文案。
func readFilePart(reader *multipart.Reader) (*uploadedInput, string) {
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			return nil, msgFileFieldMissing
		}
		if err != nil {
			return nil, msgMultipartOnly
		}
		if part.FormName() != "file" {
			// 其它字段一律忽略，读指针由下一次取分段时推进
			continue
		}

		body, err := io.ReadAll(io.LimitReader(part, MaxUploadBytes+1))
		if err != nil {
			return nil, msgMultipartOnly
		}
		if len(body) == 0 {
			return nil, msgEmptyFile
		}
		if len(body) > MaxUploadBytes {
			return nil, msgTooLarge
		}
		return &uploadedInput{
			name:        part.FileName(),
			contentType: part.Header.Get("Content-Type"),
			body:        body,
		}, ""
	}
}

// 请求头声明的长度超过上限加余量时不解析请求体；分块传输的长度为 -1，不参与此判定。
func declaredTooLarge(r *http.Request) bool {
	value := r.ContentLength
	if raw := strings.TrimSpace(r.Header.Get("Content-Length")); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {
			value = parsed
		}
	}
	return value > int64(MaxUploadBytes+uploadOverhead)
}

// 先按分段声明的 MIME 定扩展名，声明缺失或不在白名单时按原文件名后缀判定。
func resolveExtension(declaredContentType, originalName string) (string, bool) {
	mimeType := strings.ToLower(strings.TrimSpace(declaredContentType))
	if ext, ok := extByContentType[mimeType]; ok {
		return ext, true
	}
	ext, ok := extBySuffix[strings.ToLower(path.Ext(baseName(originalName)))]
	return ext, ok
}

// 按魔数核对内容与扩展名是否一致；不足 4 字节一律视为不匹配。
func magicMatches(ext string, body []byte) bool {
	if len(body) < 4 {
		return false
	}
	switch ext {
	case ".jpg":
		return body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff
	case ".png":
		return body[0] == 0x89 && body[1] == 0x50 && body[2] == 0x4e && body[3] == 0x47
	case ".gif":
		return body[0] == 0x47 && body[1] == 0x49 && body[2] == 0x46 && body[3] == 0x38
	case ".webp":
		return len(body) >= 12 &&
			body[0] == 0x52 && body[1] == 0x49 && body[2] == 0x46 && body[3] == 0x46 &&
			body[8] == 0x57 && body[9] == 0x45 && body[10] == 0x42 && body[11] == 0x50
	case ".ico":
		return body[0] == 0x00 && body[1] == 0x00 && body[2] == 0x01 && body[3] == 0x00
	case ".svg":
		return looksLikeSVG(body)
	default:
		return false
	}
}

// SVG 只能按起始内容粗判：前 256 字节去掉前导空白后以 <svg 或 <?xml 开头。
func looksLikeSVG(body []byte) bool {
	head := body
	if len(head) > 256 {
		head = head[:256]
	}
	text := strings.ToLower(strings.TrimSpace(string(head)))
	return strings.HasPrefix(text, "<svg") || strings.HasPrefix(text, "<?xml")
}

// 文件名由清洗后的原名、36 进制毫秒时间戳与随机尾缀拼成。
func newFilename(originalName, ext string) string {
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 36)
	return sanitizeBase(originalName) + "-" + stamp + "-" + randomHex(filenameRandSize) + ext
}

// 清洗原始名称：取最后一段并去掉后缀，字母数字与 _ . - 之外的字符转 -，
// 连续 - 压成一个，去首尾分隔符，截断到 48 个字符并转小写；清洗后为空用 image 兜底。
func sanitizeBase(name string) string {
	base := baseName(name)
	base = strings.TrimSuffix(base, path.Ext(base))

	var builder strings.Builder
	builder.Grow(len(base))
	lastDash := false
	for _, char := range strings.ToLower(base) {
		switch {
		case unicode.IsLetter(char) || unicode.IsDigit(char) || char == '_' || char == '.':
			builder.WriteRune(char)
			lastDash = false
		default:
			if lastDash {
				continue
			}
			builder.WriteByte('-')
			lastDash = true
		}
	}

	cleaned := strings.Trim(builder.String(), "-.")
	if cleaned == "" {
		return filenameFallback
	}
	return truncateRunes(cleaned, filenameMaxBase)
}

// 取文件名自身的最后一段，兼容浏览器回传带目录的名称。
func baseName(name string) string {
	if index := strings.LastIndexAny(name, `/\`); index >= 0 {
		return name[index+1:]
	}
	return name
}

// 按字符数截断，避免把多字节字符切成半个。
func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

// 生成随机十六进制串；随机源不可用时退化为空串，时间戳仍能避免同名覆盖。
func randomHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return ""
	}
	return hex.EncodeToString(buffer)
}

// 落点校验：清洗后的文件名必须仍直接落在 images 目录内。
func withinDir(dir, target string) bool {
	directory, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	resolved, err := filepath.Abs(target)
	if err != nil {
		return false
	}
	return filepath.Dir(resolved) == directory
}

// 写入失败按内部错误外露；无写权限时给出挂载排查提示。
func writeUploadFailure(w http.ResponseWriter, err error) {
	if os.IsPermission(err) || strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		httpapi.Internal(msgWriteDenied).Write(w)
		return
	}
	httpapi.Internal(msgWriteFailed).Write(w)
}
