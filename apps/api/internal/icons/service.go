package icons

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// 失败分类，与 TS 一致；由 handler 映射到错误码。
const (
	CodeInvalidURL       = "invalid_url"
	CodeNoCandidates     = "no_candidates"
	CodeTimeout          = "timeout"
	CodeExternal         = "external"
	CodeSessionExpired   = "session_expired"
	CodeCandidateMissing = "candidate_missing"
	CodeWriteFailed      = "write_failed"
)

// 固定中文文案，均不含内部细节。
const (
	msgInvalidURL        = "请提供有效的 http(s) 链接作为取图源地址"
	msgNoCandidates      = "未找到可用的站点图标"
	msgNoCandidatesAfter = "请求超时且未找到可用站点图标"
	msgSessionExpired    = "取图会话已过期，请重新获取"
	msgSessionBroken     = "无法建立取图会话，请稍后重试"
	msgCandidateMissing  = "候选不存在或已失效，请重新获取"
	msgCandidateInvalid  = "候选图片无效，请重新获取"
	msgMissingIDs        = "缺少会话或候选标识"
	msgPathRejected      = "资源路径校验失败"
	msgWriteDenied       = "保存图标失败：配置目录无写权限，请检查 Docker 挂载的 config/images 权限"
	msgWriteFailed       = "保存图标失败，请稍后重试"
)

// 资源文件名规则：源主机名清洗后的前缀，加时间戳与随机尾缀。
const (
	filenameFallbackBase = "site-icon"
	filenameMaxBase      = 48
	filenameRandBytes    = 4
)

// Resolve 返回的单枚候选，字段名与前端契约逐字一致。
type Candidate struct {
	CandidateID    string `json:"candidateId"`
	Tier           Tier   `json:"tier"`
	ContentType    string `json:"contentType"`
	ByteLength     int    `json:"byteLength"`
	PreviewDataURL string `json:"previewDataUrl"`
	DeclaredSizes  string `json:"declaredSizes,omitempty"`
	DeclaredType   string `json:"declaredType,omitempty"`
}

// Resolve 的成功体。
type ResolveResponse struct {
	Ok         bool        `json:"ok"`
	SourceURL  string      `json:"sourceUrl"`
	SessionID  string      `json:"sessionId"`
	Candidates []Candidate `json:"candidates"`
}

// Import 的成功体，与资源上传返回同一组字段。
type ImportResponse struct {
	Ok       bool   `json:"ok"`
	Path     string `json:"path"`
	Filename string `json:"filename"`
}

// 可外露的失败：分类决定错误码与状态码，文案已固定。
type ServiceError struct {
	Code    string
	Message string
}

// 让调用方把失败当 error 向上传递。
func (e *ServiceError) Error() string { return e.Message }

// 构造服务的输入，零值表示全部取默认：自有出网客户端、默认 TTL 与上限。
type Options struct {
	// Client 非空时用于全部出网请求；测试用它指向本地假站点
	Client *http.Client
	// SessionTTL 是 Resolve 到 Import 的有效窗口
	SessionTTL time.Duration
	// MaxSessions 是同时保留的会话数上限
	MaxSessions int
	// FetchTimeout 是单次请求超时
	FetchTimeout time.Duration
	// HTMLMaxBytes 是页面响应上限
	HTMLMaxBytes int64
	// ImageMaxBytes 是单张图片响应上限
	ImageMaxBytes int64
	// MaxRedirects 是同源跳转次数上限
	MaxRedirects int
	// MaxCandidates 是一次解析最多保留的候选数
	MaxCandidates int
	// ImagesDir 是导入落点，默认取 CONFIG_DIR/images
	ImagesDir string
}

// 承担 Resolve 与 Import 两个用例；会话与客户端在全部请求间共享。
type Service struct {
	client    *http.Client
	store     *sessionStore
	pageOpts  fetchOptions
	imageOpts fetchOptions
	maxRefs   int
	imagesDir string
}

// 构造服务；各上限取配置提供的值，缺省时回落到约定值。
func NewService(options Options) *Service {
	client := options.Client
	if client == nil {
		client = newFetchClient()
	}

	timeout := DefaultFetchTimeout
	if options.FetchTimeout > 0 {
		timeout = options.FetchTimeout
	}
	maxRedirects := MaxRedirects
	if options.MaxRedirects > 0 {
		maxRedirects = options.MaxRedirects
	}
	htmlMaxBytes := HTMLMaxBytes
	if options.HTMLMaxBytes > 0 {
		htmlMaxBytes = options.HTMLMaxBytes
	}
	imageMaxBytes := ImageMaxBytes
	if options.ImageMaxBytes > 0 {
		imageMaxBytes = options.ImageMaxBytes
	}
	maxRefs := MaxCandidates
	if options.MaxCandidates > 0 {
		maxRefs = options.MaxCandidates
	}

	imagesDir := options.ImagesDir
	if imagesDir == "" {
		imagesDir = filepath.Join(os.Getenv("CONFIG_DIR"), "images")
	}

	return &Service{
		client:    client,
		store:     newSessionStore(options.SessionTTL, options.MaxSessions),
		pageOpts:  fetchOptions{timeout: timeout, maxBytes: htmlMaxBytes, maxRedirects: maxRedirects},
		imageOpts: fetchOptions{timeout: timeout, maxBytes: imageMaxBytes, maxRedirects: maxRedirects},
		maxRefs:   maxRefs,
		imagesDir: imagesDir,
	}
}

// 抓取源地址页面并按回退链下载候选，成功后建立短会话。
// 页面抓取失败（超时、登录墙、404 等）不阻断静态回退；一枚合法候选都没有才算失败。
func (s *Service) Resolve(ctx context.Context, rawURL string) (*ResolveResponse, *ServiceError) {
	sourceURL := strings.TrimSpace(rawURL)
	if !isHTTPURL(sourceURL) {
		return nil, &ServiceError{Code: CodeInvalidURL, Message: msgInvalidURL}
	}

	pageURL := sourceURL
	pageHTML := ""
	timedOut := false
	pageResult, pageFailure := fetchResource(ctx, s.client, sourceURL, s.pageOpts)
	switch {
	case pageFailure == nil:
		pageURL = pageResult.url
		pageHTML = decodePage(pageResult.body)
	case pageFailure.kind == failureTimeout:
		timedOut = true
	}

	fromHTML := make([]iconRef, 0, 4)
	if pageHTML != "" {
		fromHTML = discoverIconRefs(pageHTML, pageURL)
	}
	refs := mergeIconDiscovery(fromHTML, pageURL)

	// 候选下载基准取最终页面地址：页面里的绝对外链不得牵引服务端跨主机出网
	downloaded := downloadCandidates(ctx, s.client, refs, s.imageOpts, pageURL, s.maxRefs)

	cached := make([]*cachedCandidate, 0, len(downloaded))
	public := make([]Candidate, 0, len(downloaded))
	for _, item := range downloaded {
		ext, ok := detectImageExt(item.body)
		if !ok {
			continue
		}
		candidateID := newCandidateID()
		if candidateID == "" {
			continue
		}
		entry := &cachedCandidate{
			candidateID:   candidateID,
			tier:          item.ref.tier,
			ext:           ext,
			contentType:   mimeTypeForImageExt(ext),
			body:          item.body,
			declaredSizes: item.ref.declaredSizes,
			declaredType:  item.ref.declaredType,
		}
		cached = append(cached, entry)
		public = append(public, Candidate{
			CandidateID:    entry.candidateID,
			Tier:           entry.tier,
			ContentType:    entry.contentType,
			ByteLength:     len(entry.body),
			PreviewDataURL: bytesToDataURL(entry.body, ext),
			DeclaredSizes:  entry.declaredSizes,
			DeclaredType:   entry.declaredType,
		})
	}

	if len(public) == 0 {
		message := msgNoCandidates
		if timedOut {
			message = msgNoCandidatesAfter
		}
		return nil, &ServiceError{Code: CodeNoCandidates, Message: message}
	}

	current := s.store.create(sourceURL, cached)
	if current.sessionID == "" {
		return nil, &ServiceError{Code: CodeExternal, Message: msgSessionBroken}
	}
	return &ResolveResponse{Ok: true, SourceURL: sourceURL, SessionID: current.sessionID, Candidates: public}, nil
}

// 从会话取出候选字节写入 images 目录，返回可写入表单的 /images 路径。
// 会话过期或候选缺失都必须让用户重新 Resolve。
func (s *Service) Import(sessionID, candidateID string) (*ImportResponse, *ServiceError) {
	trimmedSession := strings.TrimSpace(sessionID)
	trimmedCandidate := strings.TrimSpace(candidateID)
	if trimmedSession == "" || trimmedCandidate == "" {
		return nil, &ServiceError{Code: CodeCandidateMissing, Message: msgMissingIDs}
	}

	// 一次加锁内取会话与候选：会话过期要求重新 Resolve，候选缺失要求重新挑选
	current, candidate, status := s.store.lookup(trimmedSession, trimmedCandidate)
	switch status {
	case lookupSessionMissing:
		return nil, &ServiceError{Code: CodeSessionExpired, Message: msgSessionExpired}
	case lookupCandidateMissing:
		return nil, &ServiceError{Code: CodeCandidateMissing, Message: msgCandidateMissing}
	}

	// 落盘前再验一次魔法头，防止会话被污染成非图片
	ext, ok := detectImageExt(candidate.body)
	if !ok || ext != candidate.ext {
		return nil, &ServiceError{Code: CodeCandidateMissing, Message: msgCandidateInvalid}
	}

	if err := os.MkdirAll(s.imagesDir, 0o755); err != nil {
		return nil, writeFailure(err)
	}

	filename := newFilename(current.sourceURL, ext)
	absolutePath := filepath.Join(s.imagesDir, filename)
	if !withinDir(s.imagesDir, absolutePath) {
		return nil, &ServiceError{Code: CodeWriteFailed, Message: msgPathRejected}
	}
	if err := os.WriteFile(absolutePath, candidate.body, 0o644); err != nil {
		return nil, writeFailure(err)
	}
	return &ImportResponse{Ok: true, Path: "/images/" + filename, Filename: filename}, nil
}

// 文件名由源主机名清洗后的前缀、毫秒级时间戳的 36 进制与 4 字节随机尾缀拼成。
func newFilename(sourceURL string, ext ImageExt) string {
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 36)
	suffix := randomHex(filenameRandBytes)
	return sanitizeBase(hostOf(sourceURL)) + "-" + stamp + "-" + suffix + string(ext)
}

// 写入失败统一按内部错误外露；无写权限时给出挂载排查提示。
func writeFailure(err error) *ServiceError {
	if os.IsPermission(err) || strings.Contains(strings.ToLower(err.Error()), "permission denied") {
		return &ServiceError{Code: CodeWriteFailed, Message: msgWriteDenied}
	}
	return &ServiceError{Code: CodeWriteFailed, Message: msgWriteFailed}
}

// 路径边界校验：清洗后的文件名必须仍直接落在 images 目录内。
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

// 清洗名称：只留字母数字、下划线与点划，连续分隔符压成一个，去首尾分隔符并截断。
func sanitizeBase(name string) string {
	var builder strings.Builder
	builder.Grow(len(name))
	lastDash := false
	for _, char := range strings.ToLower(name) {
		if builder.Len() >= filenameMaxBase {
			break
		}
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
	cleaned := strings.Trim(builder.String(), "-")
	if cleaned == "" {
		return filenameFallbackBase
	}
	return truncateRunes(cleaned, filenameMaxBase)
}

// 按字符数截断，避免把多字节字符切成半个。
func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

// 取源地址的主机名；解析失败时回落默认前缀。
func hostOf(sourceURL string) string {
	parsed, err := url.Parse(sourceURL)
	if err != nil || parsed.Hostname() == "" {
		return filenameFallbackBase
	}
	return parsed.Hostname()
}

// 页面按 UTF-8 尽力解码，无效字节替换为占位符而不是整体失败。
func decodePage(body []byte) string {
	return strings.ToValidUTF8(string(body), "\uFFFD")
}
