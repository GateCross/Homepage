package adapters

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
)

// Transmission 的指标标识、失败文案与 RPC 状态码；文案可直接下发浏览器。
const (
	transmissionDownloadMetricID    = "download"
	transmissionUploadMetricID      = "upload"
	transmissionDownloadingMetricID = "downloading"
	transmissionSeedingMetricID     = "seeding"

	transmissionRPCFail            = "获取 Transmission 状态失败"
	transmissionRPCTimeout         = "获取 Transmission 状态超时"
	transmissionRPCNetwork         = "无法连接 Transmission RPC 接口"
	transmissionRPCBadJSON         = "Transmission RPC 响应不是有效 JSON"
	transmissionRPCBadFields       = "Transmission RPC 响应缺少必要字段"
	transmissionSessionIDFail      = "Transmission 未返回有效会话头"
	transmissionRequestFail        = "Transmission 请求失败"
	transmissionSessionHeader      = "X-Transmission-Session-Id"
	transmissionRPCMaxAttempts     = 2
	transmissionStatusDownload     = 4
	transmissionStatusDownloadWait = 3
	transmissionStatusSeed         = 6
	transmissionStatusSeedWait     = 5
)

// 一次 RPC 调用的结果；会话头缺省时沿用调用方传入的值。
type transmissionRPCResult struct {
	status    int
	body      any
	sessionID string
}

// 一次抓取到的速率与数量；数量为 nil 表示该指标不可用。
type transmissionSnapshot struct {
	downloadBps float64
	uploadBps   float64
	downloading *int
	seeding     *int
}

// transmissionAdapter 通过 RPC 读取会话速率与下载/做种数量；会话头只在单次调用内使用。
type transmissionAdapter struct{}

// 进程装配期登记到默认注册表，类型名与配置里的类型逐字一致。
func init() { _ = Register(transmissionAdapter{}) }

// 组件类型名，取值与配置里的类型逐字一致。
func (transmissionAdapter) Type() string { return "transmission" }

// 拉取一次指标；业务失败以中文原因返回，会话头与账号都不外带。
func (transmissionAdapter) Run(ctx context.Context, input RunInput) (any, error) {
	auth := readTransmissionAuth(input.Secrets)

	snapshot, err := fetchTransmissionMetrics(ctx, input.URL, auth)
	if err != nil {
		return FailureResult(LocalErrorMessage(err, transmissionRequestFail)), nil
	}
	return SuccessResult(buildTransmissionMetrics(snapshot), nil), nil
}

// RPC 鉴权：没有用户名时不发鉴权头，密码允许为空。
type transmissionAuth struct {
	header string
}

// 用户名非空且密码字段存在才发鉴权头；两者都缺时按匿名访问继续。
func readTransmissionAuth(secrets map[string]string) transmissionAuth {
	username := secrets["username"]
	password, hasPassword := secrets["password"]
	if username == "" || !hasPassword {
		return transmissionAuth{}
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
	return transmissionAuth{header: "Basic " + encoded}
}

// 先取会话统计（必出），再取种子状态（失败只让数量降级）。
func fetchTransmissionMetrics(ctx context.Context, baseURL string, auth transmissionAuth) (transmissionSnapshot, error) {
	var snapshot transmissionSnapshot
	sessionID := ""

	// 会话头在多次调用间复用，409 时换新头重试一次
	call := func(method string, args map[string]any) (any, error) {
		for attempt := 0; attempt < transmissionRPCMaxAttempts; attempt++ {
			result, err := transmissionRPC(ctx, baseURL, auth, method, args, sessionID)
			if err != nil {
				return nil, err
			}
			if result.status == http.StatusConflict {
				if result.sessionID == "" {
					return nil, NewError(transmissionSessionIDFail)
				}
				sessionID = result.sessionID
				continue
			}
			if result.status < 200 || result.status >= 300 || result.body == nil {
				return nil, NewError(transmissionRPCFail)
			}
			if result.sessionID != "" {
				sessionID = result.sessionID
			}
			return result.body, nil
		}
		return nil, NewError(transmissionSessionIDFail)
	}

	statsBody, err := call("session-stats", map[string]any{})
	if err != nil {
		return snapshot, err
	}
	if snapshot.downloadBps, snapshot.uploadBps, err = parseTransmissionSessionStats(statsBody); err != nil {
		return snapshot, err
	}

	// 数量请求失败（体积超限、超时、字段异常）只让数量不可用，不影响速率
	if torrentsBody, err := call("torrent-get", map[string]any{"fields": []string{"status"}}); err == nil {
		if downloading, seeding, ok := countTransmissionTorrents(torrentsBody); ok {
			snapshot.downloading = &downloading
			snapshot.seeding = &seeding
		}
	}
	return snapshot, nil
}

// 发一次 RPC；409 与非 2xx 只记为状态，交给调用方决定重试或降级。
func transmissionRPC(ctx context.Context, baseURL string, auth transmissionAuth, method string, args map[string]any, sessionID string) (transmissionRPCResult, error) {
	var result transmissionRPCResult

	target, err := JoinBaseURL(baseURL, "/transmission/rpc")
	if err != nil {
		return result, err
	}

	payload, err := json.Marshal(map[string]any{"method": method, "arguments": args})
	if err != nil {
		return result, NewError(transmissionRPCFail)
	}

	headers := map[string]string{
		"Content-Type": "application/json",
		"Accept":       "application/json",
	}
	if auth.header != "" {
		headers["Authorization"] = auth.header
	}
	if sessionID != "" {
		headers[transmissionSessionHeader] = sessionID
	}

	response, err := Do(ctx, target, RequestOptions{
		Method:  http.MethodPost,
		Headers: headers,
		Body:    payload,
		// 种子多时 torrent-get 的响应较大
		MaxBytes:       LargeMaxResponseBytes,
		TimeoutMessage: transmissionRPCTimeout,
		NetworkMessage: transmissionRPCNetwork,
	})
	if err != nil {
		return result, err
	}

	// 新会话头优先，缺省时沿用旧值
	result.status = response.Status
	result.sessionID = strings.TrimSpace(response.Header.Get(transmissionSessionHeader))
	if result.sessionID == "" {
		result.sessionID = sessionID
	}

	// 409 的正文通常不是 JSON，非 2xx 也不解析
	if result.status == http.StatusConflict {
		return result, nil
	}
	if !response.OK() {
		return result, nil
	}

	body, err := ReadJSONBody(response, transmissionRPCBadJSON)
	if err != nil {
		return result, err
	}
	result.body = body
	return result, nil
}

// 速率只认 downloadSpeed 与 uploadSpeed，缺一个即整体失败。
func parseTransmissionSessionStats(payload any) (float64, float64, error) {
	args, ok := transmissionRPCArguments(payload)
	if !ok {
		return 0, 0, NewError(transmissionRPCBadFields)
	}

	download, ok := NonNegativeNumber(args["downloadSpeed"])
	if !ok {
		return 0, 0, NewError(transmissionRPCBadFields)
	}
	upload, ok := NonNegativeNumber(args["uploadSpeed"])
	if !ok {
		return 0, 0, NewError(transmissionRPCBadFields)
	}
	return download, upload, nil
}

// 统计下载中与做种中的条数；torrents 不是数组时返回 false。
func countTransmissionTorrents(payload any) (int, int, bool) {
	args, ok := transmissionRPCArguments(payload)
	if !ok {
		return 0, 0, false
	}

	torrents, ok := args["torrents"].([]any)
	if !ok {
		return 0, 0, false
	}

	downloading := 0
	seeding := 0
	for _, item := range torrents {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		status, ok := NonNegativeNumber(object["status"])
		if !ok {
			continue
		}
		switch status {
		case transmissionStatusDownload, transmissionStatusDownloadWait:
			downloading++
		case transmissionStatusSeed, transmissionStatusSeedWait:
			seeding++
		}
	}
	return downloading, seeding, true
}

// 取 RPC 的 arguments 对象；缺失时退回根对象，两种形态都能读到字段。
func transmissionRPCArguments(payload any) (map[string]any, bool) {
	root, ok := payload.(map[string]any)
	if !ok {
		return nil, false
	}
	if args, ok := root["arguments"].(map[string]any); ok {
		return args, true
	}
	return root, true
}

// 状态码与速率既可能是数字也可能是数字字符串；负值按 0，无法解析时返回 false。

// 组装四项指标；数量取不到时以占位符与不可用状态呈现，不伪造 0。
func buildTransmissionMetrics(snapshot transmissionSnapshot) []Metric {
	download := ScaleByteRate(snapshot.downloadBps)
	upload := ScaleByteRate(snapshot.uploadBps)
	return []Metric{
		{ID: transmissionDownloadMetricID, Label: "下载", Value: download.Value, Unit: download.Unit, Status: MetricStatusOK},
		{ID: transmissionUploadMetricID, Label: "上传", Value: upload.Value, Unit: upload.Unit, Status: MetricStatusOK},
		CountMetric(transmissionDownloadingMetricID, "下载中", snapshot.downloading),
		CountMetric(transmissionSeedingMetricID, "做种中", snapshot.seeding),
	}
}
