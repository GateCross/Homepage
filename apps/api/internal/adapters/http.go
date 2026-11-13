package adapters

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// 出站请求的默认预算：单次请求（含跳转链）10 秒，响应体 16MB。
// 下载客户端的种子列表改用大响应上限，仍保留封顶以防异常大包拖垮进程。
const (
	DefaultTimeout          = 10 * time.Second
	DefaultMaxResponseBytes = 16 << 20
	LargeMaxResponseBytes   = 32 << 20
	maxAdapterRedirects     = 20
)

// 跨源跳转时必须剥掉的凭据类请求头。
var sensitiveHeaderNames = []string{"authorization", "proxy-authorization", "cookie"}

// Error 是适配器层可外露的中文失败原因；构造后不再拼接任何请求细节。
type Error struct {
	Message string
}

// Error 返回中文原因本身。
func (e *Error) Error() string { return e.Message }

// NewError 构造本地错误；message 须为中文且不得含密钥、Cookie 或响应正文。
func NewError(message string) *Error { return &Error{Message: message} }

// RequestOptions 控制单次出站请求；零值即默认行为（GET、10 秒、16MB、跳过证书校验）。
type RequestOptions struct {
	Method  string
	Headers map[string]string
	Body    []byte

	// Timeout 覆盖默认超时；TimeoutMessage、NetworkMessage 覆盖失败文案。
	Timeout        time.Duration
	TimeoutMessage string
	NetworkMessage string

	// VerifyTLS 为 true 时校验证书，默认跳过（内网自签与 IP 证书）。
	VerifyTLS bool
	// MaxBytes 覆盖响应体上限，小于等于 0 时按默认值。
	MaxBytes int64
}

// Response 是已读完的响应；正文在请求内按上限取回，连接随即释放。
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// OK 判断状态码是否落在 2xx。
func (r *Response) OK() bool { return r.Status >= 200 && r.Status < 300 }

// Text 返回响应正文文本，供非 JSON 接口（如 qBittorrent 登录）判断成败。
func (r *Response) Text() string { return string(r.Body) }

// SetCookieLines 返回逐行的 Set-Cookie；多行不会被合并，qBittorrent 的 SID 就在其中一行。
func (r *Response) SetCookieLines() []string {
	if r == nil {
		return nil
	}
	lines := r.Header.Values("Set-Cookie")
	if len(lines) == 0 {
		return nil
	}
	out := make([]string, len(lines))
	copy(out, lines)
	return out
}

// CookieValue 取指定名字的 Cookie 值；同名多行时取首个非空值。
func (r *Response) CookieValue(name string) (string, bool) {
	wanted := strings.TrimSpace(name)
	if wanted == "" {
		return "", false
	}
	for _, line := range r.SetCookieLines() {
		for _, part := range strings.Split(line, ";") {
			key, value, found := strings.Cut(strings.TrimSpace(part), "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), wanted) {
				continue
			}
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed, true
			}
		}
	}
	return "", false
}

// Do 发起一次出站请求并读完响应；目标地址、请求头与响应正文都不会出现在错误文案里。
func Do(ctx context.Context, rawURL string, opts RequestOptions) (*Response, error) {
	target, err := parseAdapterTarget(rawURL)
	if err != nil {
		return nil, err
	}

	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	timeoutMessage := opts.TimeoutMessage
	if timeoutMessage == "" {
		timeoutMessage = "请求外部服务超时"
	}
	networkMessage := opts.NetworkMessage
	if networkMessage == "" {
		networkMessage = "无法连接外部服务"
	}
	maxBytes := opts.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxResponseBytes
	}

	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	method := strings.TrimSpace(opts.Method)
	if method == "" {
		method = http.MethodGet
	}
	request, err := http.NewRequestWithContext(requestCtx, method, target, bodyReader(opts.Body))
	if err != nil {
		return nil, NewError("服务组件目标地址无效")
	}
	for name, value := range opts.Headers {
		request.Header.Set(name, value)
	}

	rawResponse, err := clientFor(opts.VerifyTLS).Do(request)
	if err != nil {
		return nil, transportFailure(ctx, err, timeoutMessage, networkMessage)
	}
	defer func() { _ = rawResponse.Body.Close() }()

	// 多读一个字节即可判定超限，随后丢弃连接不再续读
	payload, err := io.ReadAll(io.LimitReader(rawResponse.Body, maxBytes+1))
	if err != nil {
		return nil, transportFailure(ctx, err, timeoutMessage, networkMessage)
	}
	if int64(len(payload)) > maxBytes {
		return nil, NewError("外部服务响应体积超过限制")
	}

	return &Response{
		Status: rawResponse.StatusCode,
		Header: rawResponse.Header.Clone(),
		Body:   payload,
	}, nil
}

// GetJSON 在 Do 之后统一处理非 2xx 与非法 JSON；URL 拼接与请求头由调用方准备。
func GetJSON(ctx context.Context, rawURL string, opts RequestOptions, failMessage, badJSON string) (any, error) {
	response, err := Do(ctx, rawURL, opts)
	if err != nil {
		return nil, err
	}
	if !response.OK() {
		return nil, NewError(failMessage)
	}
	return ReadJSONBody(response, badJSON)
}

// ReadJSONBody 把响应正文解析成 JSON 值；解析失败只回显给定的中文原因，不带原文。
func ReadJSONBody(response *Response, invalidMessage string) (any, error) {
	if response == nil {
		return nil, NewError("读取外部服务响应失败")
	}
	message := invalidMessage
	if message == "" {
		message = "外部服务返回了无效的 JSON"
	}
	var value any
	if err := json.Unmarshal(response.Body, &value); err != nil {
		return nil, NewError(message)
	}
	return value, nil
}

// LocalErrorMessage 取本地中文原因；非本地错误一律回退，避免底层细节外泄。
func LocalErrorMessage(err error, fallback string) string {
	if err == nil {
		return fallback
	}
	var localErr *Error
	if errors.As(err, &localErr) && localErr.Message != "" {
		return localErr.Message
	}
	return fallback
}

// ContainsAnySecret 判断文本里是否出现任一密钥值；空值不参与判定，避免把「空串必中」当命中。
func ContainsAnySecret(text string, secrets map[string]string) bool {
	if text == "" {
		return false
	}
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if strings.Contains(text, secret) {
			return true
		}
	}
	return false
}

// JoinBaseURL 拼接基础地址与相对路径，保留基础地址已有的路径前缀，丢弃其查询与锚点。
func JoinBaseURL(baseURL, relativePath string) (string, error) {
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base.Host == "" {
		return "", NewError("服务组件目标地址无效")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", NewError("服务组件仅支持 http/https 目标")
	}

	path := relativePath
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	// 先去掉前缀末尾的斜杠再拼接，避免出现双斜杠
	prefix := strings.TrimRight(base.Path, "/")
	base.Path = collapseSlashes(prefix + path)
	base.RawPath = ""
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}

// 解析并校验目标地址，只放行 http/https。
func parseAdapterTarget(rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return "", NewError("服务组件目标地址无效")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", NewError("服务组件仅支持 http/https 目标")
	}
	return parsed.String(), nil
}

// 合并路径中的连续斜杠，保留单个分隔符。
func collapseSlashes(path string) string {
	var builder strings.Builder
	builder.Grow(len(path))
	previousSlash := false
	for _, char := range path {
		if char == '/' {
			if previousSlash {
				continue
			}
			previousSlash = true
		} else {
			previousSlash = false
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

// 请求体为空时不构造读取器，让传输层按无正文处理。
func bodyReader(body []byte) io.Reader {
	if len(body) == 0 {
		return nil
	}
	return bytes.NewReader(body)
}

// 调用方主动取消时的统一原因，调用方可据此区分取消与超时。
var ErrCancelled = errors.New("请求已取消")

// 把传输层失败映射成中文原因；调用方取消时返回可判定的取消原因，不发超时文案。
func transportFailure(ctx context.Context, err error, timeoutMessage, networkMessage string) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		if errors.Is(ctxErr, context.Canceled) {
			return ErrCancelled
		}
		return NewError(timeoutMessage)
	}
	if errors.Is(err, errTooManyRedirects) {
		return NewError("外部服务重定向次数过多")
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return NewError(timeoutMessage)
	}
	return NewError(networkMessage)
}

// errTooManyRedirects 只用于内部判定，对外文案由映射层给出。
var errTooManyRedirects = errors.New("adapter redirect limit exceeded")

// 跳过校验与校验证书各用一个连接池，避免两种信任级别相互污染。
var (
	clientsMu sync.Mutex
	clients   = map[bool]*http.Client{}
)

// 取或建对应信任级别的客户端；连接池只服务适配器出站请求，不动进程默认传输层。
func clientFor(verifyTLS bool) *http.Client {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	if client, ok := clients[verifyTLS]; ok {
		return client
	}
	client := &http.Client{
		Transport:     newAdapterTransport(verifyTLS),
		CheckRedirect: checkAdapterRedirect,
	}
	clients[verifyTLS] = client
	return client
}

// 构造适配器专用传输层；不校验证书是内网自签与 IP 证书场景的默认行为。
func newAdapterTransport(verifyTLS bool) *http.Transport {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: DefaultTimeout, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   DefaultTimeout,
		ExpectContinueTimeout: time.Second,
	}
	if !verifyTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec
	}
	return transport
}

// 跳转次数封顶，并在跨源跳转时剥掉凭据类请求头。
func checkAdapterRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= maxAdapterRedirects {
		return errTooManyRedirects
	}
	if len(via) == 0 {
		return nil
	}
	if !sameOrigin(via[len(via)-1].URL, request.URL) {
		stripSensitiveHeaders(request.Header)
	}
	return nil
}

// 两个地址的协议、主机与端口完全一致才算同源。
func sameOrigin(left, right *url.URL) bool {
	if left == nil || right == nil {
		return false
	}
	return left.Scheme == right.Scheme &&
		strings.EqualFold(left.Hostname(), right.Hostname()) &&
		left.Port() == right.Port()
}

// 删除跨源跳转不应携带的凭据类请求头。
func stripSensitiveHeaders(header http.Header) {
	for _, name := range sensitiveHeaderNames {
		header.Del(name)
	}
}
