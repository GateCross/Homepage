package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gatecross/homepage/api/internal/domain"
)

// Version 是当前运行的版本号，由构建时通过 -ldflags -X 注入，未注入时为 0.0.0。
var Version = "0.0.0"

// 远端版本检查的固定参数。
const (
	// GitHubRepo 是发布仓库，用于拼发布页地址。
	GitHubRepo = "GateCross/Homepage"
	// GitHubReleasesURL 是人工浏览发布页的地址。
	GitHubReleasesURL = "https://github.com/" + GitHubRepo + "/releases"
	// GitHubLatestReleaseAPI 是 GitHub 最新发布接口。
	GitHubLatestReleaseAPI = "https://api.github.com/repos/" + GitHubRepo + "/releases/latest"
	// GitHubAPIVersion 是接口要求的版本头取值。
	GitHubAPIVersion = "2022-11-28"
	// GitHubUserAgent 是接口要求的调用方标识。
	GitHubUserAgent = "homepage-version-check"

	// versionCheckTimeout 是单次远端检查的超时。
	versionCheckTimeout = 8 * time.Second
	// versionSuccessTTL 是成功结果的缓存时长，避免频繁打 GitHub。
	versionSuccessTTL = 6 * time.Hour
	// versionErrorTTL 是失败结果的短缓存，网络或没有 release 时尽快可重试。
	versionErrorTTL = 2 * time.Minute
	// versionMaxResponseBytes 是远端响应体上限，超出即断开。
	versionMaxResponseBytes = 1 << 20
	// versionFallback 是版本号缺省值。
	versionFallback = "0.0.0"
)

// remoteCheck 是一次远端检查的缓存条目；expiresAt 之前直接复用。
type remoteCheck struct {
	expiresAt     time.Time
	latestVersion string
	releaseURL    string
	checkError    bool
}

// 负责远端更新检查并缓存结果；不可复制，须经构造函数创建。
type VersionChecker struct {
	// Client 为 nil 时每次请求新建带超时的客户端。
	Client *http.Client
	// Now 覆盖时钟，便于测试推进缓存窗口。
	Now func() time.Time

	mu       sync.Mutex
	cached   *remoteCheck
	inflight *versionCall
}

// versionCall 是一次进行中的远端检查，跟随者等它结束后取同一结果。
type versionCall struct {
	done  chan struct{}
	entry remoteCheck
}

// 创建检查器；client 为 nil 时用默认超时的客户端。
func NewVersionChecker(client *http.Client) *VersionChecker {
	return &VersionChecker{Client: client, Now: time.Now}
}

// 进程默认检查器：缓存与去重需要跨请求共享。
var defaultVersionCheck = NewVersionChecker(nil)

// 返回本地版本，并按需触发一次远端更新检查。
// check=0 或 check=false 时绝不发起出网，只可能带上内存里尚未过期的远端缓存。
func handleVersion(w http.ResponseWriter, r *http.Request) {
	defaultVersionCheck.Serve(w, r, Version)
}

// 按查询参数决定是否出网；远端结果只用于补充字段，不影响本地版本。
func (c *VersionChecker) Serve(w http.ResponseWriter, r *http.Request, version string) {
	if version == "" {
		version = versionFallback
	}
	now := c.now()

	if !checkRemote(r) {
		WriteJSON(w, http.StatusOK, assembleVersionResponse(version, c.validCache(now)))
		return
	}

	entry, ok := c.resolve(r.Context(), now)
	if !ok {
		// 请求被取消时不再写响应
		return
	}
	WriteJSON(w, http.StatusOK, assembleVersionResponse(version, &entry))
}

// check=0 与 check=false 表示只取本地版本；其余取值（含缺省）都检查远端。
func checkRemote(r *http.Request) bool {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("check"))) {
	case "0", "false":
		return false
	}
	return true
}

// 当前时间；未注入时钟时用系统时间。
func (c *VersionChecker) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// 取未过期的缓存；没有则返回 nil。
func (c *VersionChecker) validCache(now time.Time) *remoteCheck {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cached != nil && c.cached.expiresAt.After(now) {
		return c.cached
	}
	return nil
}

// 执行或加入一次远端检查；跟随者在 ctx 取消时放弃等待。
func (c *VersionChecker) resolve(ctx context.Context, now time.Time) (remoteCheck, bool) {
	c.mu.Lock()
	if c.cached != nil && c.cached.expiresAt.After(now) {
		entry := *c.cached
		c.mu.Unlock()
		return entry, true
	}
	if c.inflight != nil {
		call := c.inflight
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.entry, true
		case <-ctx.Done():
			return remoteCheck{}, false
		}
	}
	call := &versionCall{done: make(chan struct{})}
	c.inflight = call
	c.mu.Unlock()

	entry, ok := c.fetch(ctx, now)

	c.mu.Lock()
	call.entry = entry
	if ok {
		c.cached = &entry
	}
	if c.inflight == call {
		c.inflight = nil
	}
	c.mu.Unlock()
	close(call.done)

	if ctx.Err() != nil {
		return remoteCheck{}, false
	}
	return entry, true
}

// 请求 GitHub 最新发布；失败按短缓存记一个 checkError 结果。
// 第二个返回值说明该结果是否可写入缓存：调用方取消的查询不代表远端真实状态。
func (c *VersionChecker) fetch(ctx context.Context, now time.Time) (remoteCheck, bool) {
	latest, releaseURL, ok := c.fetchLatest(ctx)
	if ctx.Err() != nil {
		return remoteCheck{expiresAt: now, checkError: true}, false
	}
	if !ok {
		return remoteCheck{expiresAt: now.Add(versionErrorTTL), checkError: true}, true
	}
	return remoteCheck{
		expiresAt:     now.Add(versionSuccessTTL),
		latestVersion: latest,
		releaseURL:    releaseURL,
	}, true
}

// 取 tag_name 与 html_url；地址缺失时按 tag 拼一个发布页地址。
func (c *VersionChecker) fetchLatest(ctx context.Context) (string, string, bool) {
	ctx, cancel := context.WithTimeout(ctx, versionCheckTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, GitHubLatestReleaseAPI, nil)
	if err != nil {
		return "", "", false
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", GitHubUserAgent)
	request.Header.Set("X-GitHub-Api-Version", GitHubAPIVersion)

	response, err := c.httpClient().Do(request)
	if err != nil {
		return "", "", false
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", "", false
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, versionMaxResponseBytes+1))
	if err != nil || len(body) > versionMaxResponseBytes {
		return "", "", false
	}

	var payload struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", "", false
	}
	tag := strings.TrimSpace(payload.TagName)
	if tag == "" {
		return "", "", false
	}

	releaseURL := strings.TrimSpace(payload.HTMLURL)
	if releaseURL == "" {
		releaseURL = GitHubReleasesURL + "/tag/" + tag
	}
	return tag, releaseURL, true
}

// 取注入的客户端；未注入时新建带超时的客户端，避免复用无超时的全局默认值。
func (c *VersionChecker) httpClient() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: versionCheckTimeout}
}

// 组装响应：远端字段只在确有值时出现，checkError 只在失败时出现。
func assembleVersionResponse(version string, remote *remoteCheck) domain.VersionResponse {
	response := domain.VersionResponse{Ok: true, Version: version}
	if remote == nil {
		return response
	}

	if remote.latestVersion != "" {
		latest := remote.latestVersion
		response.LatestVersion = &latest
		response.UpdateAvailable = isRemoteNewer(version, latest)
	}
	if remote.releaseURL != "" {
		releaseURL := remote.releaseURL
		response.ReleaseURL = &releaseURL
	}
	if remote.checkError {
		checkError := true
		response.CheckError = &checkError
	}
	return response
}

// 判断远端版本是否比本地新；任一方无法解析都返回 false。
func isRemoteNewer(local, remote string) bool {
	localVersion, ok := parseSemver(local)
	if !ok {
		return false
	}
	remoteVersion, ok := parseSemver(remote)
	if !ok {
		return false
	}

	switch compareCore(localVersion.core, remoteVersion.core) {
	case 0:
		return comparePrerelease(localVersion.prerelease, remoteVersion.prerelease) < 0
	case -1:
		return true
	default:
		return false
	}
}

// semver 是宽松解析结果：core 为数字段，prerelease 为 nil 表示正式版。
type semver struct {
	core       []int
	prerelease []any
}

// 解析宽松 semver：可选 v 前缀、允许 1 / 1.2 / 1.2.3，支持 -预发布 与 +构建元数据。
// 构建元数据不参与比较，解析时直接丢弃。
func parseSemver(raw string) (semver, bool) {
	trimmed := strings.TrimLeft(strings.TrimSpace(raw), "vV")
	if trimmed == "" {
		return semver{}, false
	}

	noBuild, _, _ := strings.Cut(trimmed, "+")
	coreText, preText, hasPre := strings.Cut(noBuild, "-")

	parts := strings.Split(coreText, ".")
	core := make([]int, 0, len(parts))
	for _, part := range parts {
		value, ok := parseDigits(part)
		if !ok {
			return semver{}, false
		}
		core = append(core, value)
	}
	if !hasPre {
		return semver{core: core}, true
	}
	if preText == "" {
		return semver{}, false
	}

	identifiers := strings.Split(preText, ".")
	prerelease := make([]any, 0, len(identifiers))
	for _, identifier := range identifiers {
		if identifier == "" {
			return semver{}, false
		}
		if value, ok := parseDigits(identifier); ok {
			prerelease = append(prerelease, value)
			continue
		}
		if !isIdentifierText(identifier) {
			return semver{}, false
		}
		prerelease = append(prerelease, identifier)
	}
	return semver{core: core, prerelease: prerelease}, true
}

// 纯数字标识符按数值处理；空串或含非数字字符返回 false。
func parseDigits(raw string) (int, bool) {
	if raw == "" {
		return 0, false
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false
	}
	return value, true
}

// 预发布标识符只允许 ASCII 字母、数字与连字符。
func isIdentifierText(raw string) bool {
	for _, char := range raw {
		switch {
		case char >= '0' && char <= '9':
		case char >= 'a' && char <= 'z':
		case char >= 'A' && char <= 'Z':
		case char == '-':
		default:
			return false
		}
	}
	return true
}

// 比较数字段：按较长的补零，逐位比较返回 -1、0 或 1。
func compareCore(left, right []int) int {
	length := len(left)
	if len(right) > length {
		length = len(right)
	}
	for index := 0; index < length; index++ {
		leftValue, rightValue := 0, 0
		if index < len(left) {
			leftValue = left[index]
		}
		if index < len(right) {
			rightValue = right[index]
		}
		if leftValue < rightValue {
			return -1
		}
		if leftValue > rightValue {
			return 1
		}
	}
	return 0
}

// 比较预发布段：正式版高于任意预发布；数字标识符低于非数字标识符。
func comparePrerelease(left, right []any) int {
	if left == nil && right == nil {
		return 0
	}
	if left == nil {
		return 1
	}
	if right == nil {
		return -1
	}

	length := len(left)
	if len(right) > length {
		length = len(right)
	}
	for index := 0; index < length; index++ {
		if index >= len(left) {
			return -1
		}
		if index >= len(right) {
			return 1
		}

		leftNumber, leftIsNumber := left[index].(int)
		rightNumber, rightIsNumber := right[index].(int)
		switch {
		case leftIsNumber && rightIsNumber:
			if leftNumber < rightNumber {
				return -1
			}
			if leftNumber > rightNumber {
				return 1
			}
		case leftIsNumber:
			return -1
		case rightIsNumber:
			return 1
		default:
			leftText, _ := left[index].(string)
			rightText, _ := right[index].(string)
			if leftText < rightText {
				return -1
			}
			if leftText > rightText {
				return 1
			}
		}
	}
	return 0
}
