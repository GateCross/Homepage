package adapters

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

// qBittorrent 的指标标识、失败文案与占位符；文案可直接下发浏览器。
const (
	qbittorrentDownloadMetricID    = "download"
	qbittorrentUploadMetricID      = "upload"
	qbittorrentDownloadingMetricID = "downloading"
	qbittorrentSeedingMetricID     = "seeding"

	qbittorrentMissingCredentials = "qBittorrent 缺少用户名或密码配置"
	qbittorrentLoginFail          = "qBittorrent 登录失败"
	qbittorrentLoginNoSession     = "qBittorrent 登录未返回有效会话"
	qbittorrentLoginTimeout       = "qBittorrent 登录超时"
	qbittorrentLoginNetwork       = "无法连接 qBittorrent 登录接口"
	qbittorrentTransferFail       = "获取 qBittorrent 传输信息失败"
	qbittorrentTransferTimeout    = "获取 qBittorrent 传输信息超时"
	qbittorrentTransferNetwork    = "无法连接 qBittorrent 传输信息接口"
	qbittorrentTransferBadJSON    = "qBittorrent 传输信息不是有效 JSON"
	qbittorrentTransferBadFields  = "qBittorrent 传输信息缺少速率字段"
	qbittorrentTorrentsTimeout    = "获取 qBittorrent 种子列表超时"
	qbittorrentTorrentsNetwork    = "无法连接 qBittorrent 种子列表接口"
	qbittorrentTorrentsBadJSON    = "qBittorrent 种子列表不是有效 JSON"
	qbittorrentRequestFail        = "qBittorrent 请求失败"
)

// qbittorrentAdapter 读取传输速率与下载/做种数量；登录会话只在单次调用内使用。
type qbittorrentAdapter struct{}

// 进程装配期登记到默认注册表，类型名与配置里的类型逐字一致。
func init() { _ = Register(qbittorrentAdapter{}) }

// 组件类型名，取值与配置里的类型逐字一致。
func (qbittorrentAdapter) Type() string { return "qbittorrent" }

// 登录后拉取一次指标；业务失败以中文原因返回，请求细节、SID 与账号都不外带。
func (qbittorrentAdapter) Run(ctx context.Context, input RunInput) (any, error) {
	auth, ok := readQbittorrentAuth(input.Secrets)
	if !ok {
		return FailureResult(qbittorrentMissingCredentials), nil
	}

	metrics, err := fetchQbittorrentMetrics(ctx, input.URL, auth)
	if err != nil {
		return FailureResult(LocalErrorMessage(err, qbittorrentRequestFail)), nil
	}
	return SuccessResult(metrics, nil), nil
}

// 登录凭据：用户名与密码都非空才可用，任一缺失都不发起请求。
type qbittorrentAuth struct {
	username string
	password string
}

// 一次抓取到的速率与数量；数量为 nil 表示该指标不可用。
type qbittorrentSnapshot struct {
	downloadBps float64
	uploadBps   float64
	downloading *int
	seeding     *int
}

// 用户名与密码任一为空都视为未配置，不回退到匿名登录。
func readQbittorrentAuth(secrets map[string]string) (qbittorrentAuth, bool) {
	username := secrets["username"]
	password := secrets["password"]
	if username == "" || password == "" {
		return qbittorrentAuth{}, false
	}
	return qbittorrentAuth{username: username, password: password}, true
}

// 会话失效时重登一次再试；第二次仍被判失效即按登录失败处理。
func fetchQbittorrentMetrics(ctx context.Context, baseURL string, auth qbittorrentAuth) ([]Metric, error) {
	sid, err := loginQbittorrent(ctx, baseURL, auth)
	if err != nil {
		return nil, err
	}

	snapshot, expired, err := fetchQbittorrentSnapshot(ctx, baseURL, sid)
	if err != nil {
		return nil, err
	}
	if expired {
		if sid, err = loginQbittorrent(ctx, baseURL, auth); err != nil {
			return nil, err
		}
		snapshot, expired, err = fetchQbittorrentSnapshot(ctx, baseURL, sid)
		if err != nil {
			return nil, err
		}
		if expired {
			return nil, NewError(qbittorrentLoginFail)
		}
	}
	return buildQbittorrentMetrics(snapshot), nil
}

// 表单登录换 SID；非 2xx、正文为 Fails. 或缺 SID 都算登录失败。
func loginQbittorrent(ctx context.Context, baseURL string, auth qbittorrentAuth) (string, error) {
	target, err := JoinBaseURL(baseURL, "/api/v2/auth/login")
	if err != nil {
		return "", err
	}

	form := url.Values{}
	form.Set("username", auth.username)
	form.Set("password", auth.password)

	response, err := Do(ctx, target, RequestOptions{
		Method:         http.MethodPost,
		Headers:        map[string]string{"Content-Type": "application/x-www-form-urlencoded"},
		Body:           []byte(form.Encode()),
		TimeoutMessage: qbittorrentLoginTimeout,
		NetworkMessage: qbittorrentLoginNetwork,
	})
	if err != nil {
		return "", err
	}
	if !response.OK() {
		return "", NewError(qbittorrentLoginFail)
	}
	// 部分版本即使 HTTP 200 也在正文里标 Fails.
	if isQbittorrentLoginRejected(response.Text()) {
		return "", NewError(qbittorrentLoginFail)
	}

	sid, ok := response.CookieValue("SID")
	if !ok {
		return "", NewError(qbittorrentLoginNoSession)
	}
	return sid, nil
}

// 正文只剩 Fails（可带句点）即判定登录被拒，其余正文一律看会话 Cookie。
func isQbittorrentLoginRejected(text string) bool {
	trimmed := strings.TrimSuffix(strings.TrimSpace(text), ".")
	return strings.EqualFold(trimmed, "fails")
}

// 速率必出；任一数量请求失败只让该计数不可用，不拖垮整张卡片。
// 401/403 表示会话已失效，返回 expired 供调用方重登。
func fetchQbittorrentSnapshot(ctx context.Context, baseURL, sid string) (qbittorrentSnapshot, bool, error) {
	var snapshot qbittorrentSnapshot

	transfer, err := qbittorrentSessionGet(ctx, baseURL, sid, "/api/v2/transfer/info", "", RequestOptions{
		TimeoutMessage: qbittorrentTransferTimeout,
		NetworkMessage: qbittorrentTransferNetwork,
	})
	if err != nil {
		return snapshot, false, err
	}
	if isAuthFailureStatus(transfer.Status) {
		return snapshot, true, nil
	}
	if !transfer.OK() {
		return snapshot, false, NewError(qbittorrentTransferFail)
	}

	payload, err := ReadJSONBody(transfer, qbittorrentTransferBadJSON)
	if err != nil {
		return snapshot, false, err
	}
	if snapshot.downloadBps, snapshot.uploadBps, err = parseQbittorrentRates(payload); err != nil {
		return snapshot, false, err
	}

	downloading, expired := countQbittorrentTorrents(ctx, baseURL, sid, "downloading")
	if expired {
		return snapshot, true, nil
	}
	seeding, expired := countQbittorrentTorrents(ctx, baseURL, sid, "seeding")
	if expired {
		return snapshot, true, nil
	}
	snapshot.downloading = downloading
	snapshot.seeding = seeding
	return snapshot, false, nil
}

// 带会话 Cookie 取一次 GET；query 为空时不拼查询串。
func qbittorrentSessionGet(ctx context.Context, baseURL, sid, path, query string, opts RequestOptions) (*Response, error) {
	target, err := JoinBaseURL(baseURL, path)
	if err != nil {
		return nil, err
	}
	if query != "" {
		target += "?" + query
	}
	opts.Method = http.MethodGet
	opts.Headers = map[string]string{"Cookie": "SID=" + sid}
	return Do(ctx, target, opts)
}

// 按状态过滤取种子条数；401/403 单独标出以便重登，其余失败一律降级为不可用。
func countQbittorrentTorrents(ctx context.Context, baseURL, sid, filter string) (*int, bool) {
	response, err := qbittorrentSessionGet(ctx, baseURL, sid, "/api/v2/torrents/info", "filter="+url.QueryEscape(filter), RequestOptions{
		// 大库的种子列表可能数 MB，仍保留封顶
		MaxBytes:       LargeMaxResponseBytes,
		TimeoutMessage: qbittorrentTorrentsTimeout,
		NetworkMessage: qbittorrentTorrentsNetwork,
	})
	if err != nil {
		return nil, false
	}
	if isAuthFailureStatus(response.Status) {
		return nil, true
	}
	if !response.OK() {
		return nil, false
	}

	payload, err := ReadJSONBody(response, qbittorrentTorrentsBadJSON)
	if err != nil {
		return nil, false
	}
	items, ok := payload.([]any)
	if !ok {
		return nil, false
	}
	count := len(items)
	return &count, false
}

// 速率只认 dl_info_speed 与 up_info_speed，任缺一个即整体失败。
func parseQbittorrentRates(payload any) (float64, float64, error) {
	object, ok := payload.(map[string]any)
	if !ok {
		return 0, 0, NewError(qbittorrentTransferBadFields)
	}

	download, ok := qbittorrentRate(object["dl_info_speed"])
	if !ok {
		return 0, 0, NewError(qbittorrentTransferBadFields)
	}
	upload, ok := qbittorrentRate(object["up_info_speed"])
	if !ok {
		return 0, 0, NewError(qbittorrentTransferBadFields)
	}
	return download, upload, nil
}

// 速率可以是数字或数字字符串，负值按 0，无法解析时返回 false。
func qbittorrentRate(value any) (float64, bool) {
	rate, ok := CoerceFiniteNumber(value)
	if !ok {
		return 0, false
	}
	if rate < 0 {
		return 0, true
	}
	return rate, true
}

// 401/403 视为登录态失效，需要重登。
func isAuthFailureStatus(status int) bool {
	return status == http.StatusUnauthorized || status == http.StatusForbidden
}

// 组装四项指标；数量取不到时以占位符与不可用状态呈现，不伪造 0。
func buildQbittorrentMetrics(snapshot qbittorrentSnapshot) []Metric {
	download := ScaleByteRate(snapshot.downloadBps)
	upload := ScaleByteRate(snapshot.uploadBps)
	return []Metric{
		{ID: qbittorrentDownloadMetricID, Label: "下载", Value: download.Value, Unit: download.Unit, Status: MetricStatusOK},
		{ID: qbittorrentUploadMetricID, Label: "上传", Value: upload.Value, Unit: upload.Unit, Status: MetricStatusOK},
		qbittorrentCountMetric(qbittorrentDownloadingMetricID, "下载中", snapshot.downloading),
		qbittorrentCountMetric(qbittorrentSeedingMetricID, "做种中", snapshot.seeding),
	}
}

// 数量指标：nil 表示取不到，其余按整数输出。
func qbittorrentCountMetric(id, label string, count *int) Metric {
	if count == nil {
		return Metric{ID: id, Label: label, Value: "—", Status: MetricStatusUnavailable}
	}
	return Metric{ID: id, Label: label, Value: *count, Status: MetricStatusOK}
}
