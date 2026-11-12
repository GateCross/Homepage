package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 计数传输层：记录出网次数，按注入的函数返回响应。
type countingTransport struct {
	count   atomic.Int64
	respond func(*http.Request) (*http.Response, error)
}

func (t *countingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	t.count.Add(1)
	return t.respond(request)
}

// 构造返回固定发布信息的传输层。
func releaseTransport(tag, htmlURL string) *countingTransport {
	return &countingTransport{respond: func(*http.Request) (*http.Response, error) {
		payload, _ := json.Marshal(map[string]any{"tag_name": tag, "html_url": htmlURL})
		return jsonResponse(http.StatusOK, payload), nil
	}}
}

// 构造必然失败的传输层。
func failingTransport() *countingTransport {
	return &countingTransport{respond: func(*http.Request) (*http.Response, error) {
		return nil, errors.New("网络不可用")
	}}
}

// 组装一个只有状态码与 JSON 正文的响应。
func jsonResponse(status int, body []byte) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(bytes.NewReader(body)),
		Header:     make(http.Header),
	}
}

// 用桩替换进程默认检查器，用例结束后恢复原值。
func restoreVersionCheck(t *testing.T, checker *VersionChecker) {
	t.Helper()
	previous := defaultVersionCheck
	defaultVersionCheck = checker
	t.Cleanup(func() { defaultVersionCheck = previous })
}

// 构造注入固定时钟与传输层的检查器。
func newStubbedChecker(transport http.RoundTripper, clock func() time.Time) *VersionChecker {
	return &VersionChecker{
		Client: &http.Client{Transport: transport},
		Now:    clock,
	}
}

// 发一次版本请求并解出响应体。
func requestVersion(t *testing.T, path string) (int, domainVersionBody) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handleVersion(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("%s 状态码 = %d，期望 200", path, recorder.Code)
	}
	var body domainVersionBody
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s 响应不是合法 JSON：%v", path, err)
	}
	return recorder.Code, body
}

// 版本响应的测试视图，字段名与契约一致。
type domainVersionBody struct {
	Ok              bool    `json:"ok"`
	Version         string  `json:"version"`
	UpdateAvailable bool    `json:"updateAvailable"`
	LatestVersion   *string `json:"latestVersion"`
	ReleaseURL      *string `json:"releaseUrl"`
	CheckError      *bool   `json:"checkError"`
}

// 远端版本更高时标记有更新，并带出发布地址。
func TestVersionReportsUpdateAvailable(t *testing.T) {
	transport := releaseTransport("v0.2.0", "https://example.com/releases/tag/v0.2.0")
	restoreVersionCheck(t, newStubbedChecker(transport, time.Now))

	_, body := requestVersion(t, "/api/version")
	if body.Version != Version || !body.Ok {
		t.Fatalf("本地版本不符：%+v", body)
	}
	if !body.UpdateAvailable {
		t.Fatal("远端更新时应置 updateAvailable=true")
	}
	if body.LatestVersion == nil || *body.LatestVersion != "v0.2.0" {
		t.Fatalf("latestVersion 不符：%+v", body.LatestVersion)
	}
	if body.ReleaseURL == nil || *body.ReleaseURL == "" {
		t.Fatal("远端成功时必须带 releaseUrl")
	}
	if body.CheckError != nil {
		t.Fatalf("成功时不得出现 checkError：%+v", body.CheckError)
	}
	if got := transport.count.Load(); got != 1 {
		t.Fatalf("应恰好出网 1 次，实得 %d", got)
	}
}

// 远端失败时只标记 checkError，本地版本照常返回，且相同失败结果在短窗口内命中缓存。
func TestVersionCachesFailuresForTwoMinutes(t *testing.T) {
	transport := failingTransport()
	now := time.Unix(1_700_000_000, 0)
	checker := newStubbedChecker(transport, func() time.Time { return now })
	restoreVersionCheck(t, checker)

	_, body := requestVersion(t, "/api/version")
	if body.CheckError == nil || !*body.CheckError {
		t.Fatalf("失败时必须带 checkError=true：%+v", body)
	}
	if body.LatestVersion != nil || body.ReleaseURL != nil {
		t.Fatalf("失败时不得带远端字段：%+v", body)
	}

	// 失败缓存 2 分钟：1 分 59 秒内不再出网
	now = now.Add(119 * time.Second)
	requestVersion(t, "/api/version")
	if got := transport.count.Load(); got != 1 {
		t.Fatalf("失败缓存窗口内不得重复出网，实际 %d 次", got)
	}

	// 超过 2 分钟后重试
	now = now.Add(2 * time.Second)
	requestVersion(t, "/api/version")
	if got := transport.count.Load(); got != 2 {
		t.Fatalf("失败缓存过期后应重试，实际 %d 次", got)
	}
}

// 成功结果缓存 6 小时，窗口内不再出网。
func TestVersionCachesSuccessForSixHours(t *testing.T) {
	transport := releaseTransport("v0.2.0", "https://example.com/r")
	now := time.Unix(1_700_000_000, 0)
	restoreVersionCheck(t, newStubbedChecker(transport, func() time.Time { return now }))

	requestVersion(t, "/api/version")
	now = now.Add(6*time.Hour - time.Second)
	requestVersion(t, "/api/version")
	if got := transport.count.Load(); got != 1 {
		t.Fatalf("成功缓存窗口内不得重复出网，实际 %d 次", got)
	}

	now = now.Add(2 * time.Second)
	requestVersion(t, "/api/version")
	if got := transport.count.Load(); got != 2 {
		t.Fatalf("成功缓存过期后应重试，实际 %d 次", got)
	}
}

// check=0 与 check=false 时一次都不出网，只回本地版本。
func TestVersionSkipsRemoteWhenCheckDisabled(t *testing.T) {
	transport := releaseTransport("v0.2.0", "https://example.com/r")
	restoreVersionCheck(t, newStubbedChecker(transport, time.Now))

	for _, path := range []string{"/api/version?check=0", "/api/version?check=false", "/api/version?check=FALSE"} {
		_, body := requestVersion(t, path)
		if body.UpdateAvailable {
			t.Fatalf("%s 不得触发远端检查：%+v", path, body)
		}
		if body.LatestVersion != nil {
			t.Fatalf("%s 未出网时不得带 latestVersion：%+v", path, body)
		}
	}
	if got := transport.count.Load(); got != 0 {
		t.Fatalf("check=0 时不得出网，实际 %d 次", got)
	}
}

// 关闭远端检查时仍可复用内存里未过期的缓存结果。
func TestVersionUsesCachedResultWhenCheckDisabled(t *testing.T) {
	transport := releaseTransport("v0.2.0", "https://example.com/r")
	now := time.Unix(1_700_000_000, 0)
	restoreVersionCheck(t, newStubbedChecker(transport, func() time.Time { return now }))

	requestVersion(t, "/api/version")
	_, body := requestVersion(t, "/api/version?check=0")
	if body.LatestVersion == nil || *body.LatestVersion != "v0.2.0" {
		t.Fatalf("未过期缓存应随 check=0 一并返回：%+v", body)
	}
	if got := transport.count.Load(); got != 1 {
		t.Fatalf("缓存命中时不得出网，实际 %d 次", got)
	}
}

// 并发请求只出网一次，其余等同一份结果。
func TestVersionDeduplicatesInflightChecks(t *testing.T) {
	release := make(chan struct{})
	transport := &countingTransport{respond: func(*http.Request) (*http.Response, error) {
		<-release
		payload, _ := json.Marshal(map[string]any{"tag_name": "v0.2.0", "html_url": "https://example.com/r"})
		return jsonResponse(http.StatusOK, payload), nil
	}}
	restoreVersionCheck(t, newStubbedChecker(transport, time.Now))

	var wg sync.WaitGroup
	for index := 0; index < 8; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			recorder := httptest.NewRecorder()
			handleVersion(recorder, httptest.NewRequest(http.MethodGet, "/api/version", nil))
			if recorder.Code != http.StatusOK {
				t.Errorf("并发请求状态码 = %d", recorder.Code)
			}
		}()
	}
	// 等所有请求进入等待后放行
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := transport.count.Load(); got != 1 {
		t.Fatalf("并发请求只应出网 1 次，实际 %d 次", got)
	}
}

// 请求取消时不再写响应，也不把取消当作远端真实结果。
func TestVersionStopsOnCancel(t *testing.T) {
	transport := &countingTransport{respond: func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	}}
	checker := newStubbedChecker(transport, time.Now)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	recorder := httptest.NewRecorder()
	checker.Serve(recorder, httptest.NewRequest(http.MethodGet, "/api/version", nil).WithContext(ctx), "1.0.0")
	if recorder.Body.Len() != 0 {
		t.Fatalf("被取消的请求不得写响应：%s", recorder.Body.String())
	}
}

// 宽松 semver 比较：正式版高于预发布，数字标识符低于非数字标识符。
func TestIsRemoteNewer(t *testing.T) {
	cases := []struct {
		local  string
		remote string
		newer  bool
	}{
		{local: "0.1.0", remote: "0.2.0", newer: true},
		{local: "0.2.0", remote: "0.1.9", newer: false},
		{local: "v0.1.0", remote: "0.1.1", newer: true},
		{local: "0.1", remote: "0.1.1", newer: true},
		{local: "1", remote: "1.0.0", newer: false},
		{local: "0.1.0-beta.1", remote: "0.1.0", newer: true},
		{local: "0.1.0", remote: "0.1.0-beta.1", newer: false},
		{local: "0.1.0-beta.1", remote: "0.1.0-beta.2", newer: true},
		{local: "0.1.0-beta.2", remote: "0.1.0-beta.10", newer: true},
		{local: "0.1.0-beta", remote: "0.1.0-beta.1", newer: true},
		{local: "0.1.0", remote: "0.1.0+build.5", newer: false},
		{local: "0.1.0", remote: "latest", newer: false},
		{local: "", remote: "1.0.0", newer: false},
		{local: "0.1.0", remote: "", newer: false},
	}
	for _, testCase := range cases {
		if got := isRemoteNewer(testCase.local, testCase.remote); got != testCase.newer {
			t.Errorf("isRemoteNewer(%q, %q) = %v，期望 %v",
				testCase.local, testCase.remote, got, testCase.newer)
		}
	}
}
