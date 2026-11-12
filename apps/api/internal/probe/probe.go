// Package probe 实现站点 HTTP 探针：按期望状态码判定可达性，并把失败归为可外传的原因。
package probe

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/gatecross/homepage/api/internal/domain"
)

// 探测结果的状态取值，与前端判别联合的 status 逐字一致。
const (
	StatusReachable         = "reachable"
	StatusReachableAbnormal = "reachable_abnormal"
	StatusUnreachable       = "unreachable"
)

// 不可达原因取值，与前端契约逐字一致。
const (
	ReasonDNS     = "dns"
	ReasonConnect = "connect"
	ReasonTLS     = "tls"
	ReasonTimeout = "timeout"
	ReasonOther   = "other"
)

// 判定与抓取相关的固定参数。
const (
	// DefaultTimeoutMs 是未给出有效超时时的兜底，避免单次探测无上限等待。
	DefaultTimeoutMs = 10_000
	// httpCodeMin 与 httpCodeMax 是合法状态码范围，越界按不可达处理。
	httpCodeMin = 100
	httpCodeMax = 599
	// maxDrainBytes 是丢弃响应体时的读取上限，避免大响应拖住探测。
	maxDrainBytes = 1 << 20
)

// Result 是一次探测的结果；按 Status 决定出现哪些字段：
// reachable 与 reachable_abnormal 带状态码与耗时，unreachable 只带原因。
type Result struct {
	Status    string  `json:"status"`
	HTTPCode  *int    `json:"httpCode,omitempty"`
	LatencyMs *int64  `json:"latencyMs,omitempty"`
	Reason    *string `json:"reason,omitempty"`
}

// attemptResult 是单次请求的中间结果：要么拿到状态码，要么只有失败原因。
type attemptResult struct {
	reached   bool
	code      int
	latencyMs int64
	reason    string
}

// 连接类失败的 errno 集合，覆盖拒绝、重置、主机与网络不可达。
var connectErrs = []error{
	syscall.ECONNREFUSED,
	syscall.ECONNRESET,
	syscall.EHOSTUNREACH,
	syscall.ENETUNREACH,
	syscall.EPIPE,
}

// Run 探测单个目标：先 HEAD，返回 405 或 501 时回退 GET，再按期望区间判定可达性。
// 不跟随重定向、不携带 Cookie 与 URL 内嵌凭据，并跳过证书校验，内网自签证书不判不可达。
func Run(ctx context.Context, targetURL string, timeoutMs int, expectedStatus []domain.StatusRange) Result {
	target, ok := parseTarget(targetURL)
	if !ok {
		return unreachable(ReasonOther)
	}
	timeout := timeoutMs
	if timeout <= 0 {
		timeout = DefaultTimeoutMs
	}

	client := newClient()
	defer client.CloseIdleConnections()

	result := attempt(ctx, client, target, http.MethodHead, timeout)
	if result.reached && shouldFallbackToGet(result.code) {
		result = attempt(ctx, client, target, http.MethodGet, timeout)
	}
	if !result.reached {
		return unreachable(result.reason)
	}
	return classify(result.code, result.latencyMs, expectedStatus)
}

// 解析目标：只接受带主机名的 http/https，并丢弃内嵌凭据，探测保持匿名。
func parseTarget(rawURL string) (*url.URL, bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" {
		return nil, false
	}
	switch parsed.Scheme {
	case "http", "https":
	default:
		return nil, false
	}
	parsed.User = nil
	return parsed, true
}

// 目标不支持 HEAD 方法时改发 GET。
func shouldFallbackToGet(code int) bool {
	return code == http.StatusMethodNotAllowed || code == http.StatusNotImplemented
}

// 构造一次性探测客户端：沿用默认传输的拨号与超时设置，只覆盖证书校验与重定向。
func newClient() *http.Client {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		base = &http.Transport{}
	}
	transport := base.Clone()
	transport.TLSClientConfig = skipVerifyTLS()
	return &http.Client{
		Transport: transport,
		// 不跟随重定向：3xx 原样作为观察到的状态码，避免探测被引到第三方地址
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// 内网服务常见自签或纯 IP 证书，探测不因证书不受信判不可达。
func skipVerifyTLS() *tls.Config {
	return &tls.Config{InsecureSkipVerify: true} //nolint:gosec
}

// 单次请求；超时按次计，HEAD 与 GET 各自独立计时。
func attempt(ctx context.Context, client *http.Client, target *url.URL, method string, timeoutMs int) attemptResult {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, method, target.String(), nil)
	if err != nil {
		return attemptResult{reason: ReasonOther}
	}

	started := time.Now()
	response, err := client.Do(request)
	if err != nil {
		return attemptResult{reason: classifyNetworkError(err)}
	}
	// 耗时只到收到响应头为止，与前端一致；随后丢弃响应体
	latencyMs := time.Since(started).Milliseconds()
	discardBody(response.Body)
	return attemptResult{reached: true, code: response.StatusCode, latencyMs: latencyMs}
}

// 丢弃响应体：读取有限长度后关闭，不占用连接也不解析内容。
func discardBody(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, maxDrainBytes))
	_ = body.Close()
}

// 状态码落在任一期望区间内为可达，否则可达但异常；未声明期望区间时任意合法状态码都可达。
func classify(code int, latencyMs int64, expected []domain.StatusRange) Result {
	if code < httpCodeMin || code > httpCodeMax {
		return unreachable(ReasonOther)
	}
	status := StatusReachable
	if len(expected) > 0 && !matchesExpected(code, expected) {
		status = StatusReachableAbnormal
	}
	return Result{Status: status, HTTPCode: intPtr(code), LatencyMs: int64Ptr(latencyMs)}
}

// 区间按闭区间比较；min 大于 max 的区间不会命中任何状态码。
func matchesExpected(code int, ranges []domain.StatusRange) bool {
	for _, statusRange := range ranges {
		if code >= statusRange.Min && code <= statusRange.Max {
			return true
		}
	}
	return false
}

// 归类出站失败：超时优先，其次 DNS、TLS 与连接，其余归 other。
func classifyNetworkError(err error) string {
	if err == nil {
		return ReasonOther
	}
	if isTimeout(err) {
		return ReasonTimeout
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return ReasonDNS
	}
	if isTLSError(err) {
		return ReasonTLS
	}
	if isConnectError(err) {
		return ReasonConnect
	}
	return ReasonOther
}

// 超时覆盖连接超时与调用方取消，两者对探测都是「未按时拿到响应」。
func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// 证书不可信、域名不符、证书无效与握手协议不匹配都归 tls。
// 明文端口被当成 https 探测时，标准库只留下文案而不保留握手错误类型，故补一层文案判定。
func isTLSError(err error) bool {
	var recordHeader tls.RecordHeaderError
	if errors.As(err, &recordHeader) {
		return true
	}
	var certVerify *tls.CertificateVerificationError
	if errors.As(err, &certVerify) {
		return true
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return true
	}
	var hostname x509.HostnameError
	if errors.As(err, &hostname) {
		return true
	}
	var certInvalid x509.CertificateInvalidError
	if errors.As(err, &certInvalid) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "tls:") ||
		strings.Contains(message, "x509:") ||
		strings.Contains(message, "http response to https client")
}

// 连接类失败：errno 判定覆盖类 Unix，拨号等操作错误覆盖 Windows 的 connectex 分支。
func isConnectError(err error) bool {
	for _, target := range connectErrs {
		if errors.Is(err, target) {
			return true
		}
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

// 构造不可达结果，原因只取契约内的五种取值。
func unreachable(reason string) Result {
	return Result{Status: StatusUnreachable, Reason: strPtr(reason)}
}

// 构造指针，供可选字段使用。
func intPtr(value int) *int { return &value }

// 构造耗时指针。
func int64Ptr(value int64) *int64 { return &value }

// 构造原因指针。
func strPtr(value string) *string { return &value }
