package adapters

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Emby 的指标标识、接口路径与失败文案；文案可直接下发浏览器。
const (
	embySessionsTotalMetricID = "sessions_total"
	embyMoviesMetricID        = "movies"
	embySeriesMetricID        = "series"
	embyEpisodesMetricID      = "episodes"
	embySongsMetricID         = "songs"

	embySessionsPath = "/Sessions"
	embyCountsPath   = "/Items/Counts"

	// 正在播放的媒体取不到任何可用名称时的标题占位。
	embyUnknownMedia = "未知媒体"

	embyMissingKey      = "Emby 缺少 API 密钥配置"
	embySessionsFail    = "获取 Emby 会话失败"
	embySessionsTimeout = "获取 Emby 会话超时"
	embySessionsNetwork = "无法连接 Emby 会话接口"
	embySessionsBadJSON = "Emby 会话响应不是有效 JSON"
	embyCountsFail      = "获取 Emby 媒体数量失败"
	embyCountsTimeout   = "获取 Emby 媒体数量超时"
	embyCountsNetwork   = "无法连接 Emby 媒体数量接口"
	embyCountsBadJSON   = "Emby 媒体数量响应不是有效 JSON"
	embyCountsBadFields = "Emby 媒体数量响应缺少计数字段"
	embyWidgetFail      = "获取 Emby 状态失败"
	embyRequestFail     = "Emby 请求失败"
)

// 读取正在播放会话与媒体库数量；API 密钥只出现在请求头里。
type embyAdapter struct{}

// 进程装配期登记到默认注册表，类型名与配置里的类型逐字一致。
func init() { _ = Register(embyAdapter{}) }

// 组件类型名，取值与配置里的类型逐字一致。
func (embyAdapter) Type() string { return "emby" }

// 缺少密钥时不发任何请求；业务失败只回中文原因，请求细节与密钥都不外带。
func (embyAdapter) Run(ctx context.Context, input RunInput) (any, error) {
	apiKey, ok := readEmbyAPIKey(input.Secrets)
	if !ok {
		return FailureResult(embyMissingKey), nil
	}

	metrics, sessions, err := fetchEmbyWidgetData(ctx, input.URL, apiKey, parseEmbyOptions(input.Options))
	if err != nil {
		return FailureResult(LocalErrorMessage(err, embyRequestFail)), nil
	}
	return SuccessResult(metrics, sessions), nil
}

// 四个展示开关与受限的媒体数量字段。
type embyWidgetOptions struct {
	enableBlocks      bool
	enableNowPlaying  bool
	enableUser        bool
	showEpisodeNumber bool
	fields            []string
}

// 未声明的开关按默认值处理：媒体数量与集号关，正在播放开，用户名关。
func parseEmbyOptions(options any) embyWidgetOptions {
	opts := embyWidgetOptions{enableNowPlaying: true}
	record, ok := options.(map[string]any)
	if !ok {
		return opts
	}
	opts.enableBlocks = embyBoolOption(record["enableBlocks"], false)
	opts.enableNowPlaying = embyBoolOption(record["enableNowPlaying"], true)
	opts.enableUser = embyBoolOption(record["enableUser"], false)
	opts.showEpisodeNumber = embyBoolOption(record["showEpisodeNumber"], false)
	opts.fields = embyFieldList(record["fields"])
	return opts
}

// 非布尔值一律回落到默认值，不按真值猜测。
func embyBoolOption(value any, fallback bool) bool {
	if flag, ok := value.(bool); ok {
		return flag
	}
	return fallback
}

// 展示字段只认非空字符串并统一小写；非字符串项直接丢弃。空列表表示不限字段。
func embyFieldList(value any) []string {
	switch typed := value.(type) {
	case []string:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if field := strings.ToLower(strings.TrimSpace(item)); field != "" {
				out = append(out, field)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				continue
			}
			if field := strings.ToLower(strings.TrimSpace(text)); field != "" {
				out = append(out, field)
			}
		}
		return out
	}
	return nil
}

// 密钥取 key，其次 token；去空白后为空即视为未配置。
func readEmbyAPIKey(secrets map[string]string) (string, bool) {
	for _, name := range []string{"key", "token"} {
		if value := strings.TrimSpace(secrets[name]); value != "" {
			return value, true
		}
	}
	return "", false
}

// 一个接口的路径与四条失败文案。
type embyEndpoint struct {
	path    string
	fail    string
	timeout string
	network string
	invalid string
}

// 两个接口并发拉取；单侧失败只丢该侧指标，两侧都失败或只开的那侧失败才整卡失败。
func fetchEmbyWidgetData(ctx context.Context, baseURL, apiKey string, opts embyWidgetOptions) ([]Metric, []SessionSummary, error) {
	if !opts.enableBlocks && !opts.enableNowPlaying {
		// 两个展示区都关掉时不发请求，直接回空指标
		return []Metric{}, nil, nil
	}

	var (
		wait           sync.WaitGroup
		countMetrics   []Metric
		sessionMetrics []Metric
		sessions       []SessionSummary
		countsFailed   bool
		sessionsFailed bool
	)

	if opts.enableBlocks {
		wait.Add(1)
		go func() {
			defer wait.Done()
			metrics, err := fetchEmbyCounts(ctx, baseURL, apiKey, opts.fields)
			if err != nil {
				countsFailed = true
				return
			}
			countMetrics = metrics
		}()
	}

	if opts.enableNowPlaying {
		wait.Add(1)
		go func() {
			defer wait.Done()
			metrics, items, err := fetchEmbySessions(ctx, baseURL, apiKey, opts.enableUser, opts.showEpisodeNumber)
			if err != nil {
				sessionsFailed = true
				return
			}
			sessionMetrics, sessions = metrics, items
		}()
	}

	wait.Wait()

	switch {
	case countsFailed && sessionsFailed:
		return nil, nil, NewError(embyWidgetFail)
	case countsFailed && !opts.enableNowPlaying:
		return nil, nil, NewError(embyCountsFail)
	case sessionsFailed && !opts.enableBlocks:
		return nil, nil, NewError(embySessionsFail)
	}

	metrics := make([]Metric, 0, len(countMetrics)+len(sessionMetrics))
	metrics = append(metrics, countMetrics...)
	metrics = append(metrics, sessionMetrics...)
	return metrics, sessions, nil
}

// 拉正在播放会话，转换成总数指标与至多五条摘要。
func fetchEmbySessions(ctx context.Context, baseURL, apiKey string, enableUser, showEpisodeNumber bool) ([]Metric, []SessionSummary, error) {
	payload, err := embyGet(ctx, baseURL, apiKey, embyEndpoint{
		path:    embySessionsPath,
		fail:    embySessionsFail,
		timeout: embySessionsTimeout,
		network: embySessionsNetwork,
		invalid: embySessionsBadJSON,
	})
	if err != nil {
		return nil, nil, err
	}
	return convertEmbySessions(payload, enableUser, showEpisodeNumber)
}

// 拉媒体库数量，按字段白名单输出。
func fetchEmbyCounts(ctx context.Context, baseURL, apiKey string, fields []string) ([]Metric, error) {
	payload, err := embyGet(ctx, baseURL, apiKey, embyEndpoint{
		path:    embyCountsPath,
		fail:    embyCountsFail,
		timeout: embyCountsTimeout,
		network: embyCountsNetwork,
		invalid: embyCountsBadJSON,
	})
	if err != nil {
		return nil, err
	}
	return convertEmbyCounts(payload, fields)
}

// 带 API 密钥取一次 GET；非 2xx 与非法 JSON 都映射成该接口自己的中文文案。
func embyGet(ctx context.Context, baseURL, apiKey string, endpoint embyEndpoint) (any, error) {
	target, err := JoinBaseURL(baseURL, endpoint.path)
	if err != nil {
		return nil, err
	}

	response, err := Do(ctx, target, RequestOptions{
		Method:         http.MethodGet,
		Headers:        map[string]string{"X-Emby-Token": apiKey, "Accept": "application/json"},
		TimeoutMessage: endpoint.timeout,
		NetworkMessage: endpoint.network,
	})
	if err != nil {
		return nil, err
	}
	if !response.OK() {
		return nil, NewError(endpoint.fail)
	}
	return ReadJSONBody(response, endpoint.invalid)
}

// 只统计 NowPlayingItem 为对象的会话；总数取过滤后的条数，摘要不超过五条。
func convertEmbySessions(payload any, enableUser, showEpisodeNumber bool) ([]Metric, []SessionSummary, error) {
	items, ok := payload.([]any)
	if !ok {
		return nil, nil, NewError(embySessionsBadJSON)
	}

	playing := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if session, ok := embyPlayingSession(item); ok {
			playing = append(playing, session)
		}
	}

	sessions := make([]SessionSummary, 0, len(playing))
	for index, session := range playing {
		if len(sessions) == MaxSessionSummaries {
			break
		}
		sessions = append(sessions, embySessionSummary(session, index, enableUser, showEpisodeNumber))
	}

	metrics := []Metric{
		{ID: embySessionsTotalMetricID, Label: "正在播放", Value: len(playing), Status: MetricStatusOK},
	}
	return metrics, sessions, nil
}

// 媒体数量字段：标识、中文标签、白名单用的字段名与接口字段的两种写法。
var embyCountFields = []struct {
	id    string
	label string
	name  string
	keys  []string
}{
	{embyMoviesMetricID, "电影", "movies", []string{"MovieCount", "movieCount"}},
	{embySeriesMetricID, "剧集", "series", []string{"SeriesCount", "seriesCount"}},
	{embyEpisodesMetricID, "集数", "episodes", []string{"EpisodeCount", "episodeCount"}},
	{embySongsMetricID, "歌曲", "songs", []string{"SongCount", "songCount"}},
}

// 逐字段取数量；接口缺某字段时记 0，避免整张卡片失败。白名单为空表示全部输出。
func convertEmbyCounts(payload any, fields []string) ([]Metric, error) {
	record, ok := payload.(map[string]any)
	if !ok {
		return nil, NewError(embyCountsBadFields)
	}

	metrics := make([]Metric, 0, len(embyCountFields))
	for _, def := range embyCountFields {
		if !embyFieldAllowed(fields, def.name) {
			continue
		}
		count := 0.0
		for _, key := range def.keys {
			if value, ok := embyNonNegNumber(record[key]); ok {
				count = value
				break
			}
		}
		metrics = append(metrics, Metric{
			ID:     def.id,
			Label:  def.label,
			Value:  int64(count),
			Status: MetricStatusOK,
		})
	}
	if len(metrics) == 0 {
		return nil, NewError(embyCountsBadFields)
	}
	return metrics, nil
}

// 白名单为空表示不限字段，否则只放行列举项。
func embyFieldAllowed(fields []string, name string) bool {
	if len(fields) == 0 {
		return true
	}
	for _, field := range fields {
		if strings.EqualFold(field, name) {
			return true
		}
	}
	return false
}

// 只有 NowPlayingItem 是对象的条目才算正在播放。
func embyPlayingSession(item any) (map[string]any, bool) {
	record, ok := item.(map[string]any)
	if !ok {
		return nil, false
	}
	if _, ok := record["NowPlayingItem"].(map[string]any); !ok {
		return nil, false
	}
	return record, true
}

// 单条摘要：标题按剧名、专辑艺人、条目名、专辑依次回退，全都取不到时用占位标题。
func embySessionSummary(record map[string]any, index int, enableUser, showEpisodeNumber bool) SessionSummary {
	nowPlaying, _ := record["NowPlayingItem"].(map[string]any)
	playState, _ := record["PlayState"].(map[string]any)

	id := embyFirstText(record["Id"], record["id"], nowPlaying["Id"])
	if id == "" {
		// 接口没给标识时按位置补一个，保证同一张卡片内不重复
		id = "session-" + strconv.Itoa(index+1)
	}

	seriesName := embyText(nowPlaying["SeriesName"])
	itemName := embyText(nowPlaying["Name"])
	album := embyText(nowPlaying["Album"])
	albumArtist := embyText(nowPlaying["AlbumArtist"])

	summary := SessionSummary{ID: id, Title: embySessionTitle(seriesName, itemName, album, albumArtist)}
	summary.Episode = embySessionEpisode(nowPlaying, seriesName, itemName, showEpisodeNumber)
	if enableUser {
		summary.User = embyFirstText(record["UserName"], record["user"])
	}
	if progress, ok := embyProgress(playState, nowPlaying); ok {
		summary.Progress = &progress
	}
	return summary
}

// 标题回退顺序与前端展示一致：剧名优先，其次「艺人 - 曲名」。
func embySessionTitle(seriesName, itemName, album, albumArtist string) string {
	switch {
	case seriesName != "":
		return seriesName
	case albumArtist != "" && itemName != "":
		return albumArtist + " - " + itemName
	case itemName != "":
		return itemName
	case album != "":
		return album
	}
	return embyUnknownMedia
}

// 剧集按开关拼「S01 · E02 集名」或只给集名；非剧集取剧集标题字段。
func embySessionEpisode(nowPlaying map[string]any, seriesName, itemName string, showEpisodeNumber bool) string {
	if seriesName == "" {
		return embyText(nowPlaying["EpisodeTitle"])
	}

	season, hasSeason := nowPlaying["ParentIndexNumber"].(float64)
	number, hasNumber := nowPlaying["IndexNumber"].(float64)
	if showEpisodeNumber && hasSeason && hasNumber {
		label := embySeasonEpisode(season, number)
		if itemName != "" {
			return label + " " + itemName
		}
		return label
	}
	return itemName
}

// 季集号取整后补到两位。
func embySeasonEpisode(season, episode float64) string {
	return "S" + embyTwoDigits(season) + " · E" + embyTwoDigits(episode)
}

// 两位数补零；超过两位保持原样。
func embyTwoDigits(value float64) string {
	text := strconv.FormatInt(int64(value), 10)
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// 进度按播放位置与时长换算成 0–100，缺时长时退到当前节目时长；分母不为正即判缺失。
func embyProgress(playState, nowPlaying map[string]any) (float64, bool) {
	position, ok := embyNonNegNumber(playState["PositionTicks"])
	if !ok {
		return 0, false
	}

	runtime, ok := embyNonNegNumber(nowPlaying["RunTimeTicks"])
	if !ok || runtime == 0 {
		program, isObject := nowPlaying["CurrentProgram"].(map[string]any)
		if !isObject {
			return 0, false
		}
		if runtime, ok = embyNonNegNumber(program["RunTimeTicks"]); !ok {
			return 0, false
		}
	}
	if runtime <= 0 {
		return 0, false
	}
	return RoundTo(ClampPercent(position/runtime*100), 1), true
}

// 取非空文本；去空白后为空与非字符串都视为缺失。
func embyText(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

// 按优先级取第一个非空文本，用于标识与用户名的多种写法。
func embyFirstText(values ...any) string {
	for _, value := range values {
		if text := embyText(value); text != "" {
			return text
		}
	}
	return ""
}

// 数量类字段可以是数字或数字字符串，负值按 0，无法解析时返回 false。
func embyNonNegNumber(value any) (float64, bool) {
	number, ok := CoerceFiniteNumber(value)
	if !ok {
		return 0, false
	}
	if number < 0 {
		return 0, true
	}
	return number, true
}
