// Package icons 实现站点图标的出网发现、候选短会话与导入落盘。
package icons

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// 出网抓取的固定上限。
const (
	// DefaultFetchTimeout 是单次请求默认超时。
	DefaultFetchTimeout = 15 * time.Second
	// HTMLMaxBytes 是页面响应上限，超限按抓取失败处理。
	HTMLMaxBytes int64 = 2 * 1024 * 1024
	// ImageMaxBytes 是单张图片响应上限，超限按抓取失败处理。
	ImageMaxBytes int64 = 5 * 1024 * 1024
	// MaxRedirects 是同源跳转的跟随次数上限。
	MaxRedirects = 5
	// MaxCandidates 是一次解析最多返回的候选数。
	MaxCandidates = 12
)

// 取图请求的固定请求头：页面与图片都要，且要求不压缩以便按字节判大小。
const (
	fetchAccept = "text/html,application/xhtml+xml,image/*,*/*;q=0.8"
	fetchAgent  = "homepage-icon-fetch/0.1"
	// drainLimit 是丢弃响应体时的读取上限，仅为让连接可复用。
	drainLimit = 64 * 1024
)

// 候选在回退链上的档位，取值与前端契约逐字一致。
type Tier string

// 回退链的四档：页面 apple-touch 声明、页面 rel=icon 声明、origin 级两个静态路径。
const (
	TierAppleTouchIcon   Tier = "apple-touch-icon"
	TierRelIcon          Tier = "rel-icon"
	TierStaticAppleTouch Tier = "static-apple-touch"
	TierStaticFavicon    Tier = "static-favicon"
)

// 识别出的图片扩展名，同时决定落盘后缀与 MIME。
type ImageExt string

// 支持识别的图片类型，覆盖资源上传允许的同一组。
const (
	ExtJPEG ImageExt = ".jpg"
	ExtPNG  ImageExt = ".png"
	ExtGIF  ImageExt = ".gif"
	ExtWebP ImageExt = ".webp"
	ExtICO  ImageExt = ".ico"
	ExtSVG  ImageExt = ".svg"
)

// 回退链上的一条待下载引用，href 已解析为绝对地址。
type iconRef struct {
	href          string
	tier          Tier
	declaredSizes string
	declaredType  string
}

// 单次抓取的超时、体积上限与跳转次数上限。
type fetchOptions struct {
	timeout      time.Duration
	maxBytes     int64
	maxRedirects int
}

// 抓取失败分类，取值与 TS 契约一致。
type failureKind string

// 抓取失败的几种归类。
const (
	failureTimeout  failureKind = "timeout"
	failureNetwork  failureKind = "network"
	failureTooLarge failureKind = "too_large"
	failureRedirect failureKind = "redirect"
	failureHTTP     failureKind = "http"
)

// 一次成功抓取：状态码、最终地址与完整响应体。
type fetchResult struct {
	statusCode int
	url        string
	body       []byte
}

// 一次失败抓取：分类决定上层文案与错误码，状态码可缺省。
type fetchFailure struct {
	kind       failureKind
	message    string
	statusCode int
}

// 下载成功的候选：原始引用与未校验的字节。
type downloadedCandidate struct {
	ref  iconRef
	body []byte
}

// 粗匹配 link 标签；属性值内的 > 会截断标签，与 TS 的正则解析一致。
var linkTagPattern = regexp.MustCompile(`(?is)<link\b[^>]*>`)

// 声明里常见的五种实体与单引号数字实体。
var htmlEntityPattern = regexp.MustCompile(`(?i)&(amp|quot|apos|lt|gt|#39);`)

// 构造取图专用客户端：忽略证书错误、不自动跟随重定向，由调用方逐跳判定同源。
func newFetchClient() *http.Client {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		base = &http.Transport{}
	}
	transport := base.Clone()
	// 仅此路径放行证书错误，内网自签与纯 IP 证书不算失败
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec
	transport.DisableCompression = true
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// 抓取单个资源，最多跟随 maxRedirects 次跳转。
// 跨源跳转、超限体积与非 2xx 状态都按失败返回，失败不携带响应体。
func fetchResource(ctx context.Context, client *http.Client, startURL string, options fetchOptions) (*fetchResult, *fetchFailure) {
	current := startURL
	for hop := 0; hop <= options.maxRedirects; hop++ {
		statusCode, location, body, failure := requestOnce(ctx, client, current, options)
		if failure != nil {
			return nil, failure
		}
		if location != "" && statusCode >= 300 && statusCode < 400 {
			next, ok := resolveReference(current, location)
			if !ok {
				return nil, &fetchFailure{kind: failureRedirect, message: "重定向地址无效", statusCode: statusCode}
			}
			if !isSameOrigin(startURL, next) {
				return nil, &fetchFailure{kind: failureRedirect, message: "拒绝跨源重定向", statusCode: statusCode}
			}
			current = next
			continue
		}
		if statusCode < 200 || statusCode >= 300 {
			return nil, &fetchFailure{
				kind:       failureHTTP,
				message:    fmt.Sprintf("目标返回 HTTP %d", statusCode),
				statusCode: statusCode,
			}
		}
		return &fetchResult{statusCode: statusCode, url: current, body: body}, nil
	}
	return nil, &fetchFailure{kind: failureRedirect, message: "重定向次数过多"}
}

// 发起一次匿名 GET：不带 Cookie 与任何凭证，返回状态码、跳转目标与响应体。
func requestOnce(ctx context.Context, client *http.Client, targetURL string, options fetchOptions) (int, string, []byte, *fetchFailure) {
	if !isHTTPURL(targetURL) {
		return 0, "", nil, &fetchFailure{kind: failureNetwork, message: "仅支持 http/https"}
	}

	requestCtx, cancel := context.WithTimeout(ctx, options.timeout)
	defer cancel()

	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return 0, "", nil, &fetchFailure{kind: failureNetwork, message: "无效的目标 URL"}
	}
	request.Header.Set("Accept", fetchAccept)
	request.Header.Set("User-Agent", fetchAgent)
	request.Header.Set("Accept-Encoding", "identity")

	response, err := client.Do(request)
	if err != nil {
		return 0, "", nil, classifyRequestError(requestCtx, err)
	}
	defer func() { _ = response.Body.Close() }()

	if location := response.Header.Get("Location"); location != "" && response.StatusCode >= 300 && response.StatusCode < 400 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, drainLimit))
		return response.StatusCode, location, nil, nil
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, options.maxBytes+1))
	if err != nil {
		return 0, "", nil, classifyRequestError(requestCtx, err)
	}
	if int64(len(body)) > options.maxBytes {
		return 0, "", nil, &fetchFailure{kind: failureTooLarge, message: "响应体超过大小上限"}
	}
	return response.StatusCode, "", body, nil
}

// 归类出网失败：超时优先，其余归为无法连接。
func classifyRequestError(ctx context.Context, err error) *fetchFailure {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return &fetchFailure{kind: failureTimeout, message: "请求外部站点超时"}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &fetchFailure{kind: failureTimeout, message: "请求外部站点超时"}
	}
	return &fetchFailure{kind: failureNetwork, message: "无法连接目标站点"}
}

// 按发现顺序下载候选，跳过失败项与跨源引用，最多保留 limit 份字节。
// 字节是否为合法图片由调用方校验。
func downloadCandidates(ctx context.Context, client *http.Client, refs []iconRef, options fetchOptions, sourceURL string, limit int) []downloadedCandidate {
	downloaded := make([]downloadedCandidate, 0, limit)
	for _, ref := range refs {
		if len(downloaded) >= limit || ctx.Err() != nil {
			break
		}
		// 第三方 HTML 里的绝对外链不得牵引服务端访问其它主机
		if sourceURL != "" && !isSameOrigin(sourceURL, ref.href) {
			continue
		}
		result, failure := fetchResource(ctx, client, ref.href, options)
		if failure != nil || len(result.body) == 0 {
			continue
		}
		downloaded = append(downloaded, downloadedCandidate{ref: ref, body: result.body})
	}
	return downloaded
}

// 从页面按文档序提取候选：apple-touch 档整体在前，rel=icon 档随后。
// 相对 href 以基准地址（通常是最终页面地址）解析。
func discoverIconRefs(htmlText, baseURL string) []iconRef {
	apple := make([]iconRef, 0, 4)
	relIcons := make([]iconRef, 0, 4)
	for _, tag := range linkTagPattern.FindAllString(htmlText, -1) {
		attrs := parseAttributes(tag)
		href := attrs["href"]
		tier, ok := classifyRel(attrs["rel"])
		if !ok || href == "" {
			continue
		}
		absolute, ok := resolveReference(baseURL, href)
		if !ok {
			continue
		}
		ref := iconRef{
			href:          absolute,
			tier:          tier,
			declaredSizes: attrs["sizes"],
			declaredType:  attrs["type"],
		}
		if tier == TierAppleTouchIcon {
			apple = append(apple, ref)
			continue
		}
		relIcons = append(relIcons, ref)
	}
	return append(apple, relIcons...)
}

// 按 rel 令牌判定档位：含 apple-touch 的两个取值归第一档，令牌里含 icon 的归第二档。
func classifyRel(rel string) (Tier, bool) {
	hasIcon := false
	for _, token := range strings.Fields(strings.ToLower(rel)) {
		if token == "apple-touch-icon" || token == "apple-touch-icon-precomposed" {
			return TierAppleTouchIcon, true
		}
		if strings.Contains(token, "icon") {
			hasIcon = true
		}
	}
	if hasIcon {
		return TierRelIcon, true
	}
	return "", false
}

// Origin 级静态回退：先 /apple-touch-icon.png，再 /favicon.ico。
func staticFallbackRefs(pageURL string) []iconRef {
	parsed, err := url.Parse(pageURL)
	if err != nil || parsed.Host == "" {
		return nil
	}
	origin := parsed.Scheme + "://" + parsed.Host
	return []iconRef{
		{href: origin + "/apple-touch-icon.png", tier: TierStaticAppleTouch},
		{href: origin + "/favicon.ico", tier: TierStaticFavicon},
	}
}

// 合并页面发现与静态回退，按 href 去重并保留首次出现的那一条。
func mergeIconDiscovery(fromHTML []iconRef, pageURL string) []iconRef {
	static := staticFallbackRefs(pageURL)
	merged := make([]iconRef, 0, len(fromHTML)+len(static))
	seen := make(map[string]struct{}, len(fromHTML)+len(static))
	for _, ref := range append(append([]iconRef{}, fromHTML...), static...) {
		if _, exists := seen[ref.href]; exists {
			continue
		}
		seen[ref.href] = struct{}{}
		merged = append(merged, ref)
	}
	return merged
}

// 解析标签内的属性：名称转小写，值做常见实体还原，未写值的属性按空串记录。
func parseAttributes(tag string) map[string]string {
	attributes := make(map[string]string, 8)
	index := 0
	for index < len(tag) {
		for index < len(tag) && isAttributeSpace(tag[index]) {
			index++
		}
		if index >= len(tag) {
			break
		}
		// 自闭合与标签结尾不构成属性
		if tag[index] == '/' || tag[index] == '>' {
			index++
			continue
		}
		start := index
		for index < len(tag) && !isAttributeSpace(tag[index]) && tag[index] != '=' && tag[index] != '>' && tag[index] != '/' {
			index++
		}
		name := strings.ToLower(tag[start:index])
		for index < len(tag) && isAttributeSpace(tag[index]) {
			index++
		}
		value := ""
		if index < len(tag) && tag[index] == '=' {
			index++
			for index < len(tag) && isAttributeSpace(tag[index]) {
				index++
			}
			if index < len(tag) && (tag[index] == '"' || tag[index] == '\'') {
				quote := tag[index]
				index++
				valueStart := index
				for index < len(tag) && tag[index] != quote {
					index++
				}
				value = tag[valueStart:index]
				if index < len(tag) {
					index++
				}
			} else {
				valueStart := index
				for index < len(tag) && !isAttributeSpace(tag[index]) && tag[index] != '>' {
					index++
				}
				value = tag[valueStart:index]
			}
		}
		// 首个 token 是标签名本身
		if name == "" || strings.HasPrefix(name, "<") {
			continue
		}
		attributes[name] = decodeHTMLEntities(value)
	}
	return attributes
}

// HTML 属性的空白分隔字符。
func isAttributeSpace(char byte) bool {
	switch char {
	case ' ', '\t', '\n', '\r', '\f':
		return true
	default:
		return false
	}
}

// 还原声明里常见的实体，未识别的保持原样。
func decodeHTMLEntities(raw string) string {
	if !strings.Contains(raw, "&") {
		return raw
	}
	return htmlEntityPattern.ReplaceAllStringFunc(raw, func(entity string) string {
		switch strings.ToLower(entity[1 : len(entity)-1]) {
		case "amp":
			return "&"
		case "quot":
			return "\""
		case "apos", "#39":
			return "'"
		case "lt":
			return "<"
		case "gt":
			return ">"
		default:
			return entity
		}
	})
}

// 以 baseURL 为基准把引用解析为绝对地址；拒绝非 http(s) 与含内嵌凭据的地址。
func resolveReference(baseURL, reference string) (string, bool) {
	trimmed := strings.TrimSpace(reference)
	if trimmed == "" {
		return "", false
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", false
	}
	ref, err := url.Parse(trimmed)
	if err != nil {
		return "", false
	}
	return normalizeHTTPURL(base.ResolveReference(ref))
}

// 只接受带主机名、协议为 http(s) 且不含内嵌凭据的地址。
func normalizeHTTPURL(parsed *url.URL) (string, bool) {
	if parsed == nil || parsed.Host == "" {
		return "", false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
	default:
		return "", false
	}
	if parsed.User != nil {
		return "", false
	}
	return parsed.String(), true
}

// 是否是可作取图源或跳转目标的 http(s) 地址。
func isHTTPURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	_, ok := normalizeHTTPURL(parsed)
	return ok
}

// 同源判定：协议、主机名与有效端口三者全同，避免同主机跨端口横向跳转。
func isSameOrigin(fromURL, toURL string) bool {
	from, err := url.Parse(fromURL)
	if err != nil {
		return false
	}
	to, err := url.Parse(toURL)
	if err != nil {
		return false
	}
	return strings.EqualFold(from.Scheme, to.Scheme) &&
		strings.EqualFold(from.Hostname(), to.Hostname()) &&
		effectivePort(from) == effectivePort(to)
}

// 有效端口：显式端口优先，否则按协议补 80/443。
func effectivePort(parsed *url.URL) string {
	if port := parsed.Port(); port != "" {
		return port
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

// 按图片魔数识别扩展名，无法识别的字节返回 false。
func detectImageExt(data []byte) (ImageExt, bool) {
	if len(data) < 4 {
		if len(data) > 0 && looksLikeSVG(data) {
			return ExtSVG, true
		}
		return "", false
	}
	switch {
	case data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return ExtJPEG, true
	case data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4e && data[3] == 0x47:
		return ExtPNG, true
	case data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x38:
		return ExtGIF, true
	case len(data) >= 12 &&
		data[0] == 0x52 && data[1] == 0x49 && data[2] == 0x46 && data[3] == 0x46 &&
		data[8] == 0x57 && data[9] == 0x45 && data[10] == 0x42 && data[11] == 0x50:
		return ExtWebP, true
	case data[0] == 0x00 && data[1] == 0x00 && data[2] == 0x01 && data[3] == 0x00:
		return ExtICO, true
	case looksLikeSVG(data):
		return ExtSVG, true
	default:
		return "", false
	}
}

// SVG 只按起始标签粗判：前 256 字节去掉前导空白后以 <svg 或 <?xml 开头。
func looksLikeSVG(data []byte) bool {
	head := data
	if len(head) > 256 {
		head = head[:256]
	}
	text := strings.ToLower(strings.TrimSpace(string(head)))
	return strings.HasPrefix(text, "<svg") || strings.HasPrefix(text, "<?xml")
}

// 扩展名到 MIME 的映射，供候选的 contentType 使用。
func mimeTypeForImageExt(ext ImageExt) string {
	switch ext {
	case ExtJPEG:
		return "image/jpeg"
	case ExtPNG:
		return "image/png"
	case ExtGIF:
		return "image/gif"
	case ExtWebP:
		return "image/webp"
	case ExtICO:
		return "image/x-icon"
	case ExtSVG:
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}

// 把候选字节编码为 data URL，供 Resolve 响应内嵌预览。
func bytesToDataURL(data []byte, ext ImageExt) string {
	return "data:" + mimeTypeForImageExt(ext) + ";base64," + base64.StdEncoding.EncodeToString(data)
}
