package adapters

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// 供测试使用的密钥；假服务会在响应里回显它，用来确认不外泄。
const embyTestKey = "emby-api-key-value"

// 按路径分发的假 Emby：会话与媒体数量各自可覆写，未覆写时回最小可用响应。
type fakeEmby struct {
	sessionsHandler http.HandlerFunc
	countsHandler   http.HandlerFunc
	sessionsCalls   int
	countsCalls     int
	headers         map[string][]string
}

// 起一个假服务并返回其地址，同时记录各请求的请求头。
func startEmby(t *testing.T, fake *fakeEmby) string {
	t.Helper()
	server := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if fake.headers == nil {
			fake.headers = map[string][]string{}
		}
		fake.headers[r.URL.Path] = append(fake.headers[r.URL.Path], r.Header.Get("X-Emby-Token"))

		switch r.URL.Path {
		case "/Sessions":
			fake.sessionsCalls++
			if fake.sessionsHandler != nil {
				fake.sessionsHandler(w, r)
				return
			}
			_, _ = w.Write([]byte(`[]`))
		case "/Items/Counts":
			fake.countsCalls++
			if fake.countsHandler != nil {
				fake.countsHandler(w, r)
				return
			}
			_, _ = w.Write([]byte(`{"MovieCount":1,"SeriesCount":2,"EpisodeCount":3,"SongCount":4}`))
		default:
			http.NotFound(w, r)
		}
	})
	return server.URL
}

// 构造一次带密钥的调用输入。
func embyInput(url string, options any) RunInput {
	return RunInput{URL: url, Secrets: map[string]string{"key": embyTestKey}, Options: options}
}

// 执行一次适配器调用并规范结果；适配器层不应向外抛错。
func runEmby(t *testing.T, input RunInput) ServiceWidgetResult {
	t.Helper()
	raw, err := embyAdapter{}.Run(context.Background(), input)
	if err != nil {
		t.Fatalf("适配器不应返回底层错误：%v", err)
	}
	return Validate(raw)
}

func TestEmbyAdapterIsRegistered(t *testing.T) {
	adapter, ok := Get("emby")
	if !ok {
		t.Fatal("emby 适配器应已登记到默认注册表")
	}
	if adapter.Type() != "emby" {
		t.Fatalf("类型名应为 emby，实得 %q", adapter.Type())
	}
}

func TestEmbyMissingKeySendsNoRequest(t *testing.T) {
	fake := &fakeEmby{}
	url := startEmby(t, fake)

	for name, secrets := range map[string]map[string]string{
		"无密钥字段": {},
		"空密钥":   {"key": "   "},
	} {
		result := runEmby(t, RunInput{URL: url, Secrets: secrets})
		if result.Ok {
			t.Fatalf("%s：缺少密钥必须失败", name)
		}
		if result.Error != embyMissingKey {
			t.Fatalf("%s：文案应为 %q，实得 %q", name, embyMissingKey, result.Error)
		}
	}
	if fake.sessionsCalls != 0 || fake.countsCalls != 0 {
		t.Fatalf("缺少密钥不得发起请求，实得会话 %d 次、数量 %d 次", fake.sessionsCalls, fake.countsCalls)
	}
}

func TestEmbyReadsTokenSecretFallback(t *testing.T) {
	// 未配 key 时回退到 token，仍按 X-Emby-Token 发送
	fake := &fakeEmby{}
	url := startEmby(t, fake)

	result := runEmby(t, RunInput{URL: url, Secrets: map[string]string{"token": "token-value"}, Options: map[string]any{"enableBlocks": true}})
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if got := fake.headers["/Items/Counts"][0]; got != "token-value" {
		t.Fatalf("令牌应作为 X-Emby-Token 发出，实得 %q", got)
	}
}

func TestEmbySendsAPIKeyHeader(t *testing.T) {
	fake := &fakeEmby{}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableBlocks": true}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	for path, values := range fake.headers {
		if len(values) == 0 || values[0] != embyTestKey {
			t.Fatalf("路径 %q 未带上 X-Emby-Token：%v", path, values)
		}
	}
}

func TestEmbyBuildsMetricsAndSessions(t *testing.T) {
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`[
				{"Id":"s1","UserName":"alice","NowPlayingItem":{"Name":"第一集","SeriesName":"示例剧集","ParentIndexNumber":1,"IndexNumber":2,"RunTimeTicks":1000},"PlayState":{"PositionTicks":250}},
				{"Id":"s2","UserName":"bob","NowPlayingItem":{"Name":"单曲","AlbumArtist":"艺人","RunTimeTicks":0}},
				{"Id":"s3"}
			]`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{
		"enableBlocks":      true,
		"enableNowPlaying":  true,
		"enableUser":        true,
		"showEpisodeNumber": true,
	}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}

	// 第三条没有 NowPlayingItem，不计入正在播放
	if got := metricByID(t, result.Metrics, embySessionsTotalMetricID); got.Value != 2 {
		t.Fatalf("正在播放应为 2，实得 %v", got.Value)
	}
	if got := metricByID(t, result.Metrics, embyMoviesMetricID); got.Value != int64(1) {
		t.Fatalf("电影应为 1，实得 %v", got.Value)
	}
	if got := metricByID(t, result.Metrics, embySongsMetricID); got.Value != int64(4) {
		t.Fatalf("歌曲应为 4，实得 %v", got.Value)
	}

	if len(result.Sessions) != 2 {
		t.Fatalf("会话摘要应为 2 条，实得 %d：%+v", len(result.Sessions), result.Sessions)
	}
	first := result.Sessions[0]
	if first.ID != "s1" || first.Title != "示例剧集" || first.User != "alice" {
		t.Fatalf("首条摘要不符：%+v", first)
	}
	if first.Episode != "S01 · E02 第一集" {
		t.Fatalf("集号应按「S01 · E02 集名」输出，实得 %q", first.Episode)
	}
	if first.Progress == nil || *first.Progress != 25 {
		t.Fatalf("进度应为 25，实得 %v", first.Progress)
	}

	// 无运行时长可用，进度缺失；非剧集走剧集标题字段
	second := result.Sessions[1]
	if second.Title != "艺人 - 单曲" {
		t.Fatalf("专辑艺人应拼成「艺人 - 曲名」，实得 %q", second.Title)
	}
	if second.Progress != nil {
		t.Fatalf("缺时长时不应给进度，实得 %v", *second.Progress)
	}
}

func TestEmbyCapsSessionsButKeepsTotal(t *testing.T) {
	items := make([]string, 0, 7)
	for index := 0; index < 7; index++ {
		items = append(items, `{"Id":"s`+embyTwoDigits(float64(index))+`","NowPlayingItem":{"Name":"影片"}}`)
	}
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("[" + strings.Join(items, ",") + "]"))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableNowPlaying": true}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if got := metricByID(t, result.Metrics, embySessionsTotalMetricID); got.Value != 7 {
		t.Fatalf("总数应为过滤后条数 7，实得 %v", got.Value)
	}
	if len(result.Sessions) != MaxSessionSummaries {
		t.Fatalf("摘要应封顶 %d 条，实得 %d", MaxSessionSummaries, len(result.Sessions))
	}
}

func TestEmbySessionDefaults(t *testing.T) {
	// 未开用户名与集号：用户名不输出，剧集只给集名
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`[{"Id":"s1","UserName":"alice","NowPlayingItem":{"Name":"第一集","SeriesName":"示例剧集","ParentIndexNumber":1,"IndexNumber":2}}]`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableNowPlaying": true}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	session := result.Sessions[0]
	if session.User != "" {
		t.Fatalf("未开用户展示时不应带用户名，实得 %q", session.User)
	}
	if session.Episode != "第一集" {
		t.Fatalf("未开集号时只给集名，实得 %q", session.Episode)
	}
}

func TestEmbySessionTitleFallbacks(t *testing.T) {
	cases := map[string]struct {
		nowPlaying map[string]any
		wantTitle  string
	}{
		"仅专辑":  {map[string]any{"Album": "专辑名"}, "专辑名"},
		"仅条目名": {map[string]any{"Name": "条目名"}, "条目名"},
		"全缺":   {map[string]any{}, embyUnknownMedia},
	}

	for name, testCase := range cases {
		summary := embySessionSummary(map[string]any{
			"Id":             "s1",
			"NowPlayingItem": testCase.nowPlaying,
		}, 0, false, false)
		if summary.Title != testCase.wantTitle {
			t.Fatalf("%s：标题应为 %q，实得 %q", name, testCase.wantTitle, summary.Title)
		}
	}
}

func TestEmbySessionIDFallsBackToPosition(t *testing.T) {
	// 接口没给任何标识时按位置补一个，避免同卡片内重复
	summary := embySessionSummary(map[string]any{"NowPlayingItem": map[string]any{"Name": "影片"}}, 2, false, false)
	if summary.ID != "session-3" {
		t.Fatalf("缺标识时应补位置序号，实得 %q", summary.ID)
	}
}

func TestEmbyProgressUsesProgramRuntime(t *testing.T) {
	// 条目没有时长时退到当前节目时长
	summary := embySessionSummary(map[string]any{
		"Id":             "s1",
		"NowPlayingItem": map[string]any{"Name": "节目", "RunTimeTicks": 0, "CurrentProgram": map[string]any{"RunTimeTicks": 2000}},
		"PlayState":      map[string]any{"PositionTicks": 500},
	}, 0, false, false)
	if summary.Progress == nil || *summary.Progress != 25 {
		t.Fatalf("应按节目时长算出 25%%，实得 %v", summary.Progress)
	}
}

func TestEmbyProgressBoundaries(t *testing.T) {
	cases := map[string]struct {
		position float64
		runtime  float64
		wantNil  bool
		want     float64
	}{
		"起点":     {0, 1000, false, 0},
		"进度过半":   {500, 1000, false, 50},
		"超出时长封顶": {2000, 1000, false, 100},
		"缺播放位置":  {0, 0, true, 0},
	}

	for name, testCase := range cases {
		summary := embySessionSummary(map[string]any{
			"Id":             "s1",
			"NowPlayingItem": map[string]any{"Name": "影片", "RunTimeTicks": testCase.runtime},
			"PlayState":      map[string]any{"PositionTicks": testCase.position},
		}, 0, false, false)

		if testCase.wantNil {
			if summary.Progress != nil {
				t.Fatalf("%s：应无进度，实得 %v", name, *summary.Progress)
			}
			continue
		}
		if summary.Progress == nil || *summary.Progress != testCase.want {
			t.Fatalf("%s：进度应为 %v，实得 %v", name, testCase.want, summary.Progress)
		}
	}
}

func TestEmbyCountsFieldWhitelist(t *testing.T) {
	fake := &fakeEmby{}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{
		"enableBlocks":     true,
		"enableNowPlaying": false,
		"fields":           []any{"MOVIES", " episodes ", 42},
	}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if len(result.Metrics) != 2 {
		t.Fatalf("白名单应只留两项，实得 %d：%+v", len(result.Metrics), result.Metrics)
	}
	metricByID(t, result.Metrics, embyMoviesMetricID)
	metricByID(t, result.Metrics, embyEpisodesMetricID)
}

func TestEmbyCountsMissingFieldsDefaultToZero(t *testing.T) {
	// 部分版本缺 SongCount，不能因此整卡失败
	fake := &fakeEmby{
		countsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"MovieCount":3}`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableBlocks": true, "enableNowPlaying": false}))
	if !result.Ok {
		t.Fatalf("应成功：%q", result.Error)
	}
	if got := metricByID(t, result.Metrics, embySongsMetricID); got.Value != int64(0) {
		t.Fatalf("缺失字段应记 0，实得 %v", got.Value)
	}
}

func TestEmbyBothDisabledSendsNoRequest(t *testing.T) {
	fake := &fakeEmby{}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableBlocks": false, "enableNowPlaying": false}))
	if !result.Ok {
		t.Fatalf("两个展示区都关时应成功返回空指标：%q", result.Error)
	}
	if len(result.Metrics) != 0 {
		t.Fatalf("应无指标，实得 %+v", result.Metrics)
	}
	if fake.sessionsCalls != 0 || fake.countsCalls != 0 {
		t.Fatalf("不应发起请求，实得会话 %d 次、数量 %d 次", fake.sessionsCalls, fake.countsCalls)
	}
}

func TestEmbyDowngradesCountsWhenSessionsFail(t *testing.T) {
	fake := &fakeEmby{
		countsHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		},
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`[{"Id":"s1","NowPlayingItem":{"Name":"影片"}}]`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableBlocks": true, "enableNowPlaying": true}))
	if !result.Ok {
		t.Fatalf("单侧失败不应拖垮整卡：%q", result.Error)
	}
	if len(result.Metrics) != 1 || result.Metrics[0].ID != embySessionsTotalMetricID {
		t.Fatalf("应只保留会话指标，实得 %+v", result.Metrics)
	}
	if len(result.Sessions) != 1 {
		t.Fatalf("会话摘要应保留，实得 %d", len(result.Sessions))
	}
}

func TestEmbyFailsWhenBothSidesFail(t *testing.T) {
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) },
		countsHandler:   func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) },
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableBlocks": true, "enableNowPlaying": true}))
	if result.Ok {
		t.Fatal("两侧都失败必须整卡失败")
	}
	if result.Error != embyWidgetFail {
		t.Fatalf("文案应为 %q，实得 %q", embyWidgetFail, result.Error)
	}
}

func TestEmbyFailsWhenOnlyEnabledSideFails(t *testing.T) {
	fake := &fakeEmby{
		countsHandler: func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) },
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableBlocks": true, "enableNowPlaying": false}))
	if result.Ok {
		t.Fatal("只开数量且数量失败时必须整卡失败")
	}
	if result.Error != embyCountsFail {
		t.Fatalf("文案应为 %q，实得 %q", embyCountsFail, result.Error)
	}
}

func TestEmbyRejectsInvalidSessionsPayload(t *testing.T) {
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"not":"an array"}`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableNowPlaying": true}))
	if result.Ok {
		t.Fatal("非数组会话响应必须失败")
	}
	// 只开了正在播放这一侧，失败按该侧文案下发
	if result.Error != embySessionsFail {
		t.Fatalf("文案应为 %q，实得 %q", embySessionsFail, result.Error)
	}
}

func TestConvertEmbySessionsRejectsNonArray(t *testing.T) {
	// 转换层单独校验形态，非数组按无效 JSON 处理
	_, _, err := convertEmbySessions(map[string]any{}, false, false)
	if err == nil {
		t.Fatal("非数组会话必须报错")
	}
	if got := LocalErrorMessage(err, ""); got != embySessionsBadJSON {
		t.Fatalf("文案应为 %q，实得 %q", embySessionsBadJSON, got)
	}
}

func TestEmbyRejectsInvalidCountsPayload(t *testing.T) {
	fake := &fakeEmby{
		countsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`[1,2,3]`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableBlocks": true, "enableNowPlaying": false}))
	if result.Ok {
		t.Fatal("非对象数量响应必须失败")
	}
	if result.Error != embyCountsFail {
		t.Fatalf("文案应为 %q，实得 %q", embyCountsFail, result.Error)
	}
}

func TestConvertEmbyCountsRejectsNonObject(t *testing.T) {
	// 转换层单独校验形态，非对象按缺计数字段处理
	if _, err := convertEmbyCounts([]any{1}, nil); err == nil {
		t.Fatal("非对象数量必须报错")
	} else if got := LocalErrorMessage(err, ""); got != embyCountsBadFields {
		t.Fatalf("文案应为 %q，实得 %q", embyCountsBadFields, got)
	}
}

func TestEmbyNeverLeaksAPIKey(t *testing.T) {
	// 服务把密钥回显在正文里，失败文案仍不得带出
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"invalid key ` + embyTestKey + `"}`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableNowPlaying": true}))
	if result.Ok {
		t.Fatal("401 必须失败")
	}
	if ContainsAnySecret(result.Error, map[string]string{"key": embyTestKey}) {
		t.Fatalf("失败文案不得含密钥：%q", result.Error)
	}
	if strings.Contains(result.Error, "invalid key") {
		t.Fatalf("失败文案不得带回响应正文：%q", result.Error)
	}
}

func TestEmbyInvalidJSONKeepsLocalMessage(t *testing.T) {
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`not json`))
		},
	}
	url := startEmby(t, fake)

	result := runEmby(t, embyInput(url, map[string]any{"enableNowPlaying": true}))
	if result.Ok {
		t.Fatal("非法 JSON 必须失败")
	}
	if result.Error != embySessionsFail {
		t.Fatalf("文案应为 %q，实得 %q", embySessionsFail, result.Error)
	}
}

func TestEmbyGetReportsInvalidJSON(t *testing.T) {
	// 单接口取数时，非法 JSON 直接按该接口的无效 JSON 文案返回
	fake := &fakeEmby{
		sessionsHandler: func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`not json`))
		},
	}
	url := startEmby(t, fake)

	_, err := embyGet(context.Background(), url, embyTestKey, embyEndpoint{
		path:    embySessionsPath,
		fail:    embySessionsFail,
		timeout: embySessionsTimeout,
		network: embySessionsNetwork,
		invalid: embySessionsBadJSON,
	})
	if err == nil {
		t.Fatal("非法 JSON 必须报错")
	}
	if got := LocalErrorMessage(err, ""); got != embySessionsBadJSON {
		t.Fatalf("文案应为 %q，实得 %q", embySessionsBadJSON, got)
	}
}
