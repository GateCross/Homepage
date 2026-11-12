package config

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// 容器登记键固定为 server::container；同一对重复登记只保留一条。
func TestDockerContainerKeyFormatAndDedupe(t *testing.T) {
	if key := DockerContainerKey("my-docker", "qbittorrent"); key != "my-docker::qbittorrent" {
		t.Fatalf("登记键格式不符：%q", key)
	}

	dir := writeConfigDir(t, map[string]string{
		FileDocker: testDockerYAML,
		FileServices: `- 服务:
    - name: 一号
      href: http://192.168.50.10:8080
      server: my-docker
      container: shared
    - name: 二号
      href: http://192.168.50.11:8080
      server: my-docker
      container: shared
    - name: 三号
      href: http://192.168.50.12:8080
      server: my-docker
      container: other
`,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	if len(snapshot.AllowList.DockerContainers) != 2 {
		t.Fatalf("重复登记应去重，实得 %d 条：%v", len(snapshot.AllowList.DockerContainers), snapshot.AllowList.DockerContainers)
	}
	for _, key := range []string{"my-docker::shared", "my-docker::other"} {
		if _, ok := snapshot.AllowList.DockerContainers[key]; !ok {
			t.Errorf("缺少登记键 %q", key)
		}
	}
}

// 整值 ${ENV_VAR} 插值：已定义的变量替换为取值，未定义的保留原样占位符。
func TestInterpolationResolvesDefinedAndKeepsMissing(t *testing.T) {
	t.Setenv("HOMEPAGE_TEST_TITLE", "实验室首页")
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "title: \"${HOMEPAGE_TEST_TITLE}\"\nfavicon: \"${HOMEPAGE_TEST_ABSENT_VAR}\"\n",
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	if got := snapshot.Config.Settings.Title; got != "实验室首页" {
		t.Errorf("已定义变量应被替换，得到 %q", got)
	}
	if snapshot.Config.Settings.Favicon == nil {
		t.Fatal("未定义变量的字段仍应输出")
	}
	if got := *snapshot.Config.Settings.Favicon; got != "${HOMEPAGE_TEST_ABSENT_VAR}" {
		t.Errorf("未定义变量应保留原样，得到 %q", got)
	}

	// 原始树始终保留占位符，写回时不会把取值落盘
	editable, err := BuildEditableConfig(snapshot)
	if err != nil {
		t.Fatalf("投影失败：%v", err)
	}
	if editable.Settings.Favicon == nil || *editable.Settings.Favicon != "${HOMEPAGE_TEST_ABSENT_VAR}" {
		t.Errorf("可编辑视图应输出原始占位符：%+v", editable.Settings)
	}
}

// 只有整值是占位符时才插值；嵌在文本里的占位符保持原样。
func TestInterpolationOnlyAppliesToWholeValue(t *testing.T) {
	t.Setenv("HOMEPAGE_TEST_TOKEN", "abc123")
	dir := writeConfigDir(t, map[string]string{
		FileSettings: `title: Bearer ${HOMEPAGE_TEST_TOKEN}
favicon: "${HOMEPAGE_TEST_TOKEN}"
`,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	if got := snapshot.Config.Settings.Title; got != "Bearer ${HOMEPAGE_TEST_TOKEN}" {
		t.Errorf("嵌入型占位符不得插值，得到 %q", got)
	}
	if snapshot.Config.Settings.Favicon == nil || *snapshot.Config.Settings.Favicon != "abc123" {
		t.Errorf("整值占位符应被替换：%+v", snapshot.Config.Settings.Favicon)
	}
}

// 密钥字段引用未定义变量时给出组件级错误，且不登记服务端目标。
func TestMissingSecretEnvLeavesWidgetUnregistered(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{
		FileServices: `- 服务:
    - name: qBittorrent
      href: http://192.168.50.10:8080
      widget:
        type: qbittorrent
        url: http://192.168.50.10:8080
        username: admin
        password: "${HOMEPAGE_TEST_ABSENT_SECRET}"
`,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	if len(snapshot.AllowList.WidgetTargets) != 0 {
		t.Errorf("密钥无法解析时不得登记服务端目标：%v", snapshot.AllowList.WidgetTargets)
	}

	service, ok := snapshot.Config.Services[0].Items[0].(ServiceJSON)
	if !ok || service.Widget == nil {
		t.Fatalf("应保留组件引用：%+v", snapshot.Config.Services[0].Items[0])
	}
	if service.Widget.WidgetID != nil {
		t.Error("未登记的组件不得带 widgetId")
	}
	if service.Widget.Error == nil || *service.Widget.Error == "" {
		t.Error("密钥无法解析时应给出组件级错误")
	}
}

// 可编辑端点对未知子路径返回 JSON 404，不得回退到 SPA 或规范化配置。
func TestHandlerUnknownSubpathReturnsJSON404(t *testing.T) {
	handler := NewHandler(NewStore())
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/config/unknown", nil))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码应为 404，实得 %d", recorder.Code)
	}
	body := decodeJSONMap(t, recorder.Body.Bytes())
	if ok, _ := body["ok"].(bool); ok {
		t.Error("错误信封的 ok 必须为 false")
	}
	if code := childMap(t, body, "error")["code"]; code != "NOT_FOUND" {
		t.Errorf("错误码应为 NOT_FOUND，实得 %v", code)
	}
}
