package probe

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gatecross/homepage/api/internal/domain"
)

// 取失败原因的可读文案，供失败消息使用；缺失时给出占位。
func reasonOf(result Result) string {
	if result.Reason == nil {
		return "<nil>"
	}
	return *result.Reason
}

// 状态码为 200 且未声明期望区间时判可达，并带上状态码与耗时。
func TestRunReachable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	result := Run(context.Background(), server.URL, 5_000, nil)

	if result.Status != StatusReachable {
		t.Fatalf("状态应为 %s，实得 %s", StatusReachable, result.Status)
	}
	if result.HTTPCode == nil || *result.HTTPCode != http.StatusOK {
		t.Fatalf("状态码应为 200，实得 %v", result.HTTPCode)
	}
	if result.LatencyMs == nil || *result.LatencyMs < 0 {
		t.Fatalf("耗时应为非负值，实得 %v", result.LatencyMs)
	}
	if result.Reason != nil {
		t.Fatalf("可达结果不应带原因，实得 %s", *result.Reason)
	}
}

// 状态码落在声明的期望区间内仍判可达。
func TestRunReachableWithinExpectedRange(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	result := Run(context.Background(), server.URL, 5_000, []domain.StatusRange{
		{Min: 200, Max: 299},
	})

	if result.Status != StatusReachable {
		t.Fatalf("204 落在 200-299 内应判可达，实得 %s", result.Status)
	}
}

// 状态码不在期望区间内判可达但异常，状态码仍须原样带出。
func TestRunReachableAbnormal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	result := Run(context.Background(), server.URL, 5_000, []domain.StatusRange{
		{Min: 200, Max: 299},
	})

	if result.Status != StatusReachableAbnormal {
		t.Fatalf("500 不在 200-299 内应判异常，实得 %s", result.Status)
	}
	if result.HTTPCode == nil || *result.HTTPCode != http.StatusInternalServerError {
		t.Fatalf("状态码应为 500，实得 %v", result.HTTPCode)
	}
}

// 多个期望区间取并集，命中任意一个即可达。
func TestRunReachableAcrossMultipleRanges(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	result := Run(context.Background(), server.URL, 5_000, []domain.StatusRange{
		{Min: 200, Max: 299},
		{Min: 401, Max: 403},
	})

	if result.Status != StatusReachable {
		t.Fatalf("401 命中第二个区间应判可达，实得 %s", result.Status)
	}
}

// 服务端对 HEAD 返回 405 时回退 GET，最终以 GET 的状态码判定。
func TestRunFallsBackToGetOnMethodNotAllowed(t *testing.T) {
	var headCalls, getCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			headCalls++
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		getCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	result := Run(context.Background(), server.URL, 5_000, nil)

	if headCalls != 1 || getCalls != 1 {
		t.Fatalf("应先 HEAD 再回退一次 GET，实得 HEAD %d 次、GET %d 次", headCalls, getCalls)
	}
	if result.Status != StatusReachable || result.HTTPCode == nil || *result.HTTPCode != http.StatusOK {
		t.Fatalf("回退后应按 200 判可达，实得状态 %s、码 %v", result.Status, result.HTTPCode)
	}
}

// 服务端长时间不响应时判超时，耗时应明显短于等待上限之外的额外拖延。
func TestRunTimeout(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	// 先关闭再等处理函数退出，避免测试结束时阻塞
	defer func() {
		close(release)
		server.Close()
	}()

	result := Run(context.Background(), server.URL, 200, nil)

	if result.Status != StatusUnreachable {
		t.Fatalf("无响应应判不可达，实得 %s", result.Status)
	}
	if result.Reason == nil || *result.Reason != ReasonTimeout {
		t.Fatalf("原因应为 %s，实得 %s", ReasonTimeout, reasonOf(result))
	}
}

// 连接被拒绝时判不可达，并按 connect 归类。
func TestRunConnectionRefused(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("无法占用本地端口：%v", err)
	}
	address := listener.Addr().String()
	// 端口释放后无人监听，连接必然被拒
	if err := listener.Close(); err != nil {
		t.Fatalf("关闭监听失败：%v", err)
	}

	result := Run(context.Background(), "http://"+address+"/", 2_000, nil)

	if result.Status != StatusUnreachable {
		t.Fatalf("连接被拒应判不可达，实得 %s", result.Status)
	}
	if result.Reason == nil || *result.Reason != ReasonConnect {
		t.Fatalf("原因应为 %s，实得 %s", ReasonConnect, reasonOf(result))
	}
}

// 非 http/https 目标不发请求，直接按 other 判不可达。
func TestRunRejectsUnsupportedScheme(t *testing.T) {
	for _, target := range []string{"ftp://example.com/", "file:///etc/passwd", "", "http://"} {
		result := Run(context.Background(), target, 1_000, nil)
		if result.Status != StatusUnreachable {
			t.Errorf("%q 应判不可达，实得 %s", target, result.Status)
		}
		if result.Reason == nil || *result.Reason != ReasonOther {
			t.Errorf("%q 原因应为 %s，实得 %s", target, ReasonOther, reasonOf(result))
		}
	}
}

// 3xx 不跟随：重定向原样作为观察到的状态码，须在有限时间内返回。
func TestRunDoesNotFollowRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/next", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	done := make(chan Result, 1)
	go func() {
		done <- Run(context.Background(), server.URL, 5_000, []domain.StatusRange{{Min: 200, Max: 299}})
	}()

	select {
	case result := <-done:
		if result.Status != StatusReachableAbnormal {
			t.Fatalf("302 不在 200-299 内应判异常，实得 %s", result.Status)
		}
		if result.HTTPCode == nil || *result.HTTPCode != http.StatusFound {
			t.Fatalf("应返回 302 本身，实得 %v", result.HTTPCode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("探测未在预期时间内返回，可能跟随了重定向")
	}
}

// 用 https 探测明文端口时握手失败，按 tls 归类。
func TestRunTLSHandshakeFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	target := "https://" + strings.TrimPrefix(server.URL, "http://") + "/"
	result := Run(context.Background(), target, 3_000, nil)

	if result.Status != StatusUnreachable {
		t.Fatalf("握手失败应判不可达，实得 %s", result.Status)
	}
	if result.Reason == nil || *result.Reason != ReasonTLS {
		t.Fatalf("原因应为 %s，实得 %s", ReasonTLS, reasonOf(result))
	}
}

// 自签证书的 https 服务不因证书不受信判不可达，探测对证书整体跳过校验。
func TestRunSelfSignedCertStillReachable(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	result := Run(context.Background(), server.URL, 3_000, nil)

	if result.Status != StatusReachable {
		t.Fatalf("自签证书应判可达，实得 %s", result.Status)
	}
	if result.HTTPCode == nil || *result.HTTPCode != http.StatusOK {
		t.Fatalf("状态码应为 200，实得 %v", result.HTTPCode)
	}
}

// 目标 URL 内嵌的用户名口令不参与探测，服务端不得收到 Authorization。
func TestRunDropsURLCredentials(t *testing.T) {
	var authorization []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = append(authorization, r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	target := strings.Replace(server.URL, "http://", "http://user:secret@", 1)
	Run(context.Background(), target, 3_000, nil)

	for _, value := range authorization {
		if value != "" {
			t.Fatalf("探测不得携带凭据，实得 %q", value)
		}
	}
}
