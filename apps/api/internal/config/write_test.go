package config

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 写回成功后配置可被重新加载：磁盘内容是新的，加载结果与新值一致。
func TestWriteConfigPersistsAndReloads(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings:  "title: 改前\nuseEqualHeights: false\n",
		FileServices:  testServicesYAML,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")

	payload := baseWritePayload()
	payload.Settings.Title = "改后"
	payload.Settings.UseEqualHeights = true
	payload.Services = []EditableServiceGroupWrite{{
		Name:  "新分组",
		Items: []EditableServiceItemWrite{{Name: "新条目", Href: strPtr("https://example.com/new")}},
	}}

	snapshot, err := WriteConfig(context.Background(), dir, payload)
	if err != nil {
		t.Fatalf("写回失败：%v", err)
	}
	if snapshot == nil || snapshot.Config.Settings.Title != "改后" {
		t.Fatalf("写回后返回的快照应是新配置：%+v", snapshot)
	}

	// 重新从磁盘加载，内容必须与写回值一致
	reloaded, err := Load(dir)
	if err != nil {
		t.Fatalf("写回后重新加载失败：%v", err)
	}
	if reloaded.Config.Settings.Title != "改后" {
		t.Errorf("标题应为「改后」，实得 %q", reloaded.Config.Settings.Title)
	}
	if !reloaded.Config.Settings.UseEqualHeights {
		t.Error("等高开关应写回 true")
	}

	// 编辑器提交的分组与条目落到磁盘
	if len(reloaded.Config.Services) != 1 || reloaded.Config.Services[0].Name != "新分组" {
		t.Fatalf("服务分组未按写回内容重建：%+v", reloaded.Config.Services)
	}

	rawSettings, err := os.ReadFile(filepath.Join(dir, FileSettings))
	if err != nil {
		t.Fatalf("读取设置文件失败：%v", err)
	}
	if !strings.Contains(string(rawSettings), "title: 改后") {
		t.Errorf("磁盘上的标题未更新：\n%s", rawSettings)
	}
}

// 表单里没有出现的字段必须原样保留：用可编辑视图整份回写后逐项核对。
func TestWriteConfigPreservesUnknownFields(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "providers:\n  openweathermap: key\nbackground:\n  image: https://example.com/bg.jpg\n" +
			"title: HomePage\nlanguage: zh-CN\nheaderStyle: boxedWidgets\nfavicon: /images/favicon.ico\n" +
			"layout:\n  Server:\n    style: row\n    columns: 6\nfullWidth: false\nmaxGroupColumns: 4\n" +
			"maxBookmarkGroupColumns: null\nuseEqualHeights: true\n",
		FileServices: `- Server:
    - name: PVE
      href: https://192.168.50.100:8006
      siteMonitor: https://192.168.50.100:8006
      icon: /images/pve.ico
      ping: 192.168.50.100
    - name: qBittorrent
      href: http://192.168.50.10:8080
      server: my-docker
      container: qbittorrent
      showStats: true
      widget:
        type: qbittorrent
        url: http://192.168.50.10:8080
        username: admin
        password: ${QBIT_TEST_PASSWORD}
        customUnknownKey: keep-me
`,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")

	original, err := Load(dir)
	if err != nil {
		t.Fatalf("初次加载失败：%v", err)
	}
	editable, err := BuildEditableConfig(original)
	if err != nil {
		t.Fatalf("投影失败：%v", err)
	}

	// 把可编辑视图转成写回载荷：密钥状态视图换成 keep 指令
	payload, err := ParseEditableConfigWrite(editableViewToWritePayload(t, editable))
	if err != nil {
		t.Fatalf("视图转写回载荷失败：%v", err)
	}
	if _, err := WriteConfig(context.Background(), dir, payload); err != nil {
		t.Fatalf("写回失败：%v", err)
	}

	after, err := Load(dir)
	if err != nil {
		t.Fatalf("写回后加载失败：%v", err)
	}

	settingsRaw := after.Raw[FileSettings].(*orderedMap)
	for _, key := range []string{"providers", "language", "headerStyle", "fullWidth", "maxGroupColumns", "maxBookmarkGroupColumns"} {
		if !hasKey(settingsRaw, key) {
			t.Errorf("设置段的未知键 %q 被丢弃", key)
		}
	}
	// 背景原为 {image: ...} 形态，回写后应保持对象形态
	if background, ok := settingsRaw.values["background"].(*orderedMap); !ok || !hasKey(background, "image") {
		t.Errorf("背景对象形态未保留：%#v", settingsRaw.values["background"])
	}

	servicesRaw, ok := after.Raw[FileServices].([]any)
	if !ok || len(servicesRaw) != 1 {
		t.Fatalf("服务文档形态不符：%#v", after.Raw[FileServices])
	}
	group := servicesRaw[0].(*orderedMap)
	items, _ := group.values["Server"].([]any)
	if len(items) != 2 {
		t.Fatalf("服务条目数量不符：%d", len(items))
	}
	pve := items[0].(*orderedMap)
	if !hasKey(pve, "ping") {
		t.Error("服务条目的未知键 ping 被丢弃")
	}
	if icon, _ := pve.values["icon"].(string); icon != "/images/pve.ico" {
		t.Errorf("图标应原样保留，实得 %q", icon)
	}
	qbittorrent := items[1].(*orderedMap)
	if !hasKey(qbittorrent, "showStats") {
		t.Error("服务条目的未知键 showStats 被丢弃")
	}
	widget, ok := qbittorrent.values["widget"].(*orderedMap)
	if !ok {
		t.Fatalf("组件声明丢失：%#v", qbittorrent.values["widget"])
	}
	if !hasKey(widget, "customUnknownKey") {
		t.Error("组件的未知键被丢弃")
	}
	// 密钥是 keep：磁盘占位符原样保留，不得落明文
	if password, _ := widget.values["password"].(string); password != "${QBIT_TEST_PASSWORD}" {
		t.Errorf("keep 应保留磁盘占位符，实得 %q", password)
	}

	// 磁盘原文不得出现插值后的明文
	rawServices, err := os.ReadFile(filepath.Join(dir, FileServices))
	if err != nil {
		t.Fatalf("读取服务文件失败：%v", err)
	}
	if bytes.Contains(rawServices, []byte("secret-value")) {
		t.Error("写回不得把插值后的密钥明文落盘")
	}
}

// 密钥三态：set 写新值、clear 删键、未提交保留磁盘值。
func TestWriteConfigSecretModes(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileServices: `- 服务:
    - name: 保留
      href: http://192.168.50.10:8080
      widget:
        type: qbittorrent
        url: http://192.168.50.10:8080
        username: admin
        password: ${QBIT_TEST_PASSWORD}
    - name: 清空
      href: http://192.168.50.11:8080
      widget:
        type: emby
        url: http://192.168.50.11:8096
        key: old-key
`,
	})
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")

	keep := &SecretFieldWrite{Mode: SecretModeKeep}
	set := &SecretFieldWrite{Mode: SecretModeSet, Value: "new-key"}
	clear := &SecretFieldWrite{Mode: SecretModeClear}

	payload := baseWritePayload()
	payload.Services = []EditableServiceGroupWrite{{
		Name: "服务",
		Items: []EditableServiceItemWrite{
			{
				Name: "保留", Href: strPtr("http://192.168.50.10:8080"),
				Widget: &EditableServiceWidgetWrite{
					Type: "qbittorrent", URL: strPtr("http://192.168.50.10:8080"),
					Username: keep, Password: keep,
				},
			},
			{
				Name: "清空", Href: strPtr("http://192.168.50.11:8080"),
				Widget: &EditableServiceWidgetWrite{
					Type: "emby", URL: strPtr("http://192.168.50.11:8096"),
					Key: set, Token: clear,
				},
			},
		},
	}}
	if _, err := WriteConfig(context.Background(), dir, payload); err != nil {
		t.Fatalf("写回失败：%v", err)
	}

	after := mustLoad(t, dir)
	items := serviceItems(t, after)
	keptWidget := items[0].(*orderedMap).values["widget"].(*orderedMap)
	if value, _ := keptWidget.values["password"].(string); value != "${QBIT_TEST_PASSWORD}" {
		t.Errorf("keep 应保留磁盘占位符，实得 %q", value)
	}
	clearedWidget := items[1].(*orderedMap).values["widget"].(*orderedMap)
	if value, _ := clearedWidget.values["key"].(string); value != "new-key" {
		t.Errorf("set 应写入新值，实得 %q", value)
	}
	if hasKey(clearedWidget, "token") {
		t.Error("clear 应删除该字段")
	}
}

// 非法载荷被拒且不落盘：内容与写回前逐字节一致。
func TestWriteConfigRejectsInvalidPayloadWithoutTouchingDisk(t *testing.T) {
	resetConfigGate(t)
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")

	const validHead = `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},`

	cases := map[string]struct {
		body string
		code string
		path string
	}{
		"连接串含内嵌凭据": {
			body: validHead + `"services":[],"bookmarks":[],"infoWidgets":[],
				"dockerEndpoints":[{"name":"remote","connection":"tcp://user:pa55word@10.0.0.2:2375"}]}`,
			code: codeDockerConnectionSensitive,
			path: "dockerEndpoints.0.connection",
		},
		"载荷类型不符": {
			body: `{"settings":{"title":1,"useEqualHeights":false,"layout":[]},
				"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			path: "settings.title",
		},
		"布局列数为零": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[{"groupName":"A","maxColumns":0}]},
				"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			path: "settings.layout.0.maxColumns",
		},
		"分组内同名条目无法对应": {
			body: validHead + `"services":[{"name":"Server","items":[
					{"name":"同名","href":"https://example.com/a"},
					{"name":"同名","href":"https://example.com/b"},
					{"name":"同名","href":"https://example.com/c"}]}],
				"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			path: "services.0.items.2",
		},
		"服务分组名为空": {
			body: validHead + `"services":[{"name":"  ","items":[]}],
				"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			path: "services.0.name",
		},
		"书签分组名为空": {
			body: validHead + `"services":[],"bookmarks":[{"name":"","items":[]}],
				"infoWidgets":[],"dockerEndpoints":[]}`,
			path: "bookmarks.0.name",
		},
		"docker 端点名为空": {
			body: validHead + `"services":[],"bookmarks":[],"infoWidgets":[],
				"dockerEndpoints":[{"name":" ","connection":"unix:///var/run/docker.sock"}]}`,
			path: "dockerEndpoints.0.name",
		},
	}

	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			dir := writeConfigDir(t, map[string]string{
				FileSettings:  "title: 原始\n",
				FileServices:  "- Server:\n    - name: 同名\n      href: https://example.com/a\n    - name: 同名\n      href: https://example.com/b\n",
				FileBookmarks: testBookmarksYAML,
				FileWidgets:   testWidgetsYAML,
				FileDocker:    testDockerYAML,
			})
			before := snapshotDirectory(t, dir)

			_, err := writeThroughParser(t, dir, testCase.body)
			if err == nil {
				t.Fatal("非法载荷应返回错误")
			}

			var configErr *EditableConfigError
			if !asConfigError(err, &configErr) {
				t.Fatalf("错误类型不符：%T", err)
			}
			if configErr.Code != testCase.code {
				t.Errorf("错误码应为 %q，得到 %q（文案 %q）", testCase.code, configErr.Code, configErr.Message)
			}
			if configErr.Path != testCase.path {
				t.Errorf("错误路径 = %q，期望 %q（文案 %q）", configErr.Path, testCase.path, configErr.Message)
			}
			assertDirectoryUnchanged(t, dir, before)
		})
	}
}

// keep 遇到非字符串的磁盘密钥值时拒绝写回，而不是静默丢弃该值。
func TestWriteConfigKeepRejectsNonStringDiskSecret(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "title: 原始\n",
		FileServices: `- 服务:
    - name: 数字密钥
      href: http://192.168.50.10:8080
      widget:
        type: emby
        url: http://192.168.50.10:8096
        key: 12345
`,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})
	before := snapshotDirectory(t, dir)

	keep := &SecretFieldWrite{Mode: SecretModeKeep}
	payload := baseWritePayload()
	payload.Services = []EditableServiceGroupWrite{{
		Name: "服务",
		Items: []EditableServiceItemWrite{{
			Name: "数字密钥", Href: strPtr("http://192.168.50.10:8080"),
			Widget: &EditableServiceWidgetWrite{
				Type: "emby", URL: strPtr("http://192.168.50.10:8096"), Key: keep,
			},
		}},
	}}

	_, err := WriteConfig(context.Background(), dir, payload)
	if err == nil {
		t.Fatal("keep 遇到非字符串磁盘值应拒绝写回")
	}
	var configErr *EditableConfigError
	if !asConfigError(err, &configErr) {
		t.Fatalf("错误类型不符：%T", err)
	}
	if !strings.Contains(configErr.Message, "无法安全保留") {
		t.Errorf("错误文案不符：%q", configErr.Message)
	}
	assertDirectoryUnchanged(t, dir, before)
}

// 写回请求体不是 JSON 对象时同样被拒且不落盘。
func TestWriteConfigRejectsNonJSONBodyWithoutTouchingDisk(t *testing.T) {
	resetConfigGate(t)

	for name, body := range map[string]string{
		"空请求体":  ``,
		"数组请求体": `[]`,
		"纯文本":   `title: 新标题`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := writeConfigDir(t, map[string]string{
				FileSettings:  "title: 原始\n",
				FileServices:  testServicesYAML,
				FileBookmarks: testBookmarksYAML,
				FileWidgets:   testWidgetsYAML,
				FileDocker:    testDockerYAML,
			})
			before := snapshotDirectory(t, dir)

			decoder := json.NewDecoder(strings.NewReader(body))
			decoder.UseNumber()
			var decoded any
			if decodeErr := decoder.Decode(&decoded); decodeErr == nil {
				if _, err := ParseEditableConfigWrite(decoded); err == nil {
					t.Fatal("非对象载荷应被拒绝")
				}
			}
			assertDirectoryUnchanged(t, dir, before)
		})
	}
}

// 载荷结构校验：缺字段、类型不符、非法枚举都带路径拒绝。
func TestParseEditableConfigWriteValidation(t *testing.T) {
	valid := json.RawMessage(`{
		"settings": {"title": "t", "useEqualHeights": false, "layout": []},
		"services": [],
		"bookmarks": [],
		"infoWidgets": [],
		"dockerEndpoints": []
	}`)

	t.Run("合法载荷通过", func(t *testing.T) {
		payload, err := parseJSONPayload(t, valid)
		if err != nil {
			t.Fatalf("合法载荷被拒绝：%v", err)
		}
		if payload.Settings.Title != "t" {
			t.Errorf("标题解析不符：%q", payload.Settings.Title)
		}
	})

	cases := map[string]struct {
		body     string
		wantPath string
	}{
		"根不是对象": {
			body:     `[]`,
			wantPath: "$",
		},
		"缺设置段": {
			body:     `{"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			wantPath: "settings",
		},
		"布局列数为零": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[{"groupName":"A","maxColumns":0}]},
				"services":[],"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			wantPath: "settings.layout.0.maxColumns",
		},
		"窗口目标非法": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
				"services":[{"name":"G","items":[{"name":"A","target":"_evil"}]}],
				"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			wantPath: "services.0.items.0.target",
		},
		"密钥模式非法": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
				"services":[{"name":"G","items":[{"name":"A","widget":{"type":"emby","key":{"mode":"reset"}}}]}],
				"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			wantPath: "services.0.items.0.widget.key.mode",
		},
		"set 缺少值": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
				"services":[{"name":"G","items":[{"name":"A","widget":{"type":"emby","key":{"mode":"set"}}}]}],
				"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			wantPath: "services.0.items.0.widget.key.value",
		},
		"信息组件类型未知": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
				"services":[],"bookmarks":[],"infoWidgets":[{"type":"weather"}],"dockerEndpoints":[]}`,
			wantPath: "infoWidgets.0.type",
		},
		"天气缺城市编码": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
				"services":[],"bookmarks":[],"infoWidgets":[{"type":"openmeteo","location":"绵阳"}],"dockerEndpoints":[]}`,
			wantPath: "infoWidgets.0.cityId",
		},
		"超时越界": {
			body: `{"settings":{"title":"t","useEqualHeights":false,"layout":[]},
				"services":[{"name":"G","items":[{"name":"A","httpProbe":{"enabled":true,"timeoutSec":120}}]}],
				"bookmarks":[],"infoWidgets":[],"dockerEndpoints":[]}`,
			wantPath: "services.0.items.0.httpProbe.timeoutSec",
		},
	}

	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parseJSONPayload(t, json.RawMessage(testCase.body))
			if err == nil {
				t.Fatal("非法载荷应被拒绝")
			}
			var configErr *EditableConfigError
			if !asConfigError(err, &configErr) {
				t.Fatalf("错误类型不符：%T", err)
			}
			if configErr.Path != testCase.wantPath {
				t.Errorf("错误路径 = %q，期望 %q（文案 %q）", configErr.Path, testCase.wantPath, configErr.Message)
			}
		})
	}
}

// 旁路字段不得生效：提交里带上 allowList、secrets、resolved* 等键一律忽略。
func TestParseEditableConfigWriteIgnoresBypassKeys(t *testing.T) {
	body := json.RawMessage(`{
		"settings": {"title": "t", "useEqualHeights": false, "layout": []},
		"services": [], "bookmarks": [], "infoWidgets": [], "dockerEndpoints": [],
		"allowList": {"secrets": ["leak"]},
		"resolvedSecrets": {"password": "leak"},
		"clientMeta": {"version": 1}
	}`)
	payload, err := parseJSONPayload(t, body)
	if err != nil {
		t.Fatalf("带旁路字段的载荷应被接受：%v", err)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	if strings.Contains(string(encoded), "leak") {
		t.Errorf("旁路字段不得进入解析结果：%s", encoded)
	}
}

// 信息组件写回：已知类型按编辑器顺序重排，未知类型原样保留，未提交的键删除。
func TestWriteConfigInfoWidgetsRespectEditorAndKeepUnknown(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "title: 原始\n",
		FileWidgets: `- type: datetime
  timezone: Asia/Shanghai
  label: 本地时间
  customA: 1
- type: resources
  cpu: true
  disk: /
  customB: 2
- type: 未知组件
  payload: 保留我
`,
		FileDocker: testDockerYAML,
	})

	// 顺序反转，且只给时间组件的时区，不给标签与格式
	payload := baseWritePayload()
	payload.InfoWidgets = []EditableInfoWidgetWrite{
		{Type: "resources", CPU: boolPointer(true)},
		{Type: "datetime", Timezone: strPtr("Asia/Tokyo")},
	}
	if _, err := WriteConfig(context.Background(), dir, payload); err != nil {
		t.Fatalf("写回失败：%v", err)
	}

	after := mustLoad(t, dir)
	entries, ok := after.Raw[FileWidgets].([]any)
	if !ok {
		t.Fatalf("信息组件文档形态不符：%#v", after.Raw[FileWidgets])
	}
	if len(entries) != 3 {
		t.Fatalf("条目数应为 3，实得 %d", len(entries))
	}

	// 顺序跟随编辑器
	if token := entries[0].(*orderedMap).values["type"]; token != "resources" {
		t.Errorf("首个条目应为 resources，实得 %v", token)
	}
	if token := entries[1].(*orderedMap).values["type"]; token != "datetime" {
		t.Errorf("第二个条目应为 datetime，实得 %v", token)
	}
	// 未知类型原样追加，不得丢失
	if token := entries[2].(*orderedMap).values["type"]; token != "未知组件" {
		t.Errorf("未知类型应原样保留，实得 %v", token)
	}

	datetime := entries[1].(*orderedMap)
	if !hasKey(datetime, "customA") {
		t.Error("时间组件的未知键应保留")
	}
	if hasKey(datetime, "label") {
		t.Error("编辑器未提交的 label 应被删除")
	}
	if timezone, _ := datetime.values["timezone"].(string); timezone != "Asia/Tokyo" {
		t.Errorf("时区应写回编辑器值，实得 %q", timezone)
	}
}

// docker 端点：已有端点保持原位置，新端点追加，非字符串连接值原样保留。
func TestWriteConfigDockerEndpointOrdering(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "title: 原始\n",
		FileDocker: `first: unix:///var/run/docker.sock
weird:
  nested: value
second: tcp://10.0.0.2:2375
`,
	})

	payload := baseWritePayload()
	payload.DockerEndpoints = []EditableDockerEndpoint{
		{Name: "first", Connection: "unix:///run/docker.sock"},
		{Name: "second", Connection: "https://10.0.0.2:2376"},
		{Name: "third", Connection: "unix:///run/third.sock"},
	}
	if _, err := WriteConfig(context.Background(), dir, payload); err != nil {
		t.Fatalf("写回失败：%v", err)
	}

	docker := mustLoad(t, dir).Raw[FileDocker].(*orderedMap)
	wantKeys := []string{"first", "weird", "second", "third"}
	if strings.Join(docker.keys, ",") != strings.Join(wantKeys, ",") {
		t.Errorf("端点键序 = %v，期望 %v", docker.keys, wantKeys)
	}
	if connection, _ := docker.values["first"].(string); connection != "unix:///run/docker.sock" {
		t.Errorf("已有端点应就地更新：%q", connection)
	}
	if _, kept := docker.values["weird"].(*orderedMap); !kept {
		t.Error("非字符串连接值必须原样保留")
	}
	if connection, _ := docker.values["third"].(string); connection != "unix:///run/third.sock" {
		t.Errorf("新端点应追加：%q", connection)
	}
}

// 基础载荷：全是空集合的合法写回体。
func baseWritePayload() EditableConfigWrite {
	return EditableConfigWrite{
		Settings: EditableSettingsWrite{Title: "标题", Layout: nil},
	}
}

func strPtr(value string) *string { return &value }

func boolPointer(value bool) *bool { return &value }

// 加载必须成功，失败直接终止用例。
func mustLoad(t *testing.T, dir string) *Snapshot {
	t.Helper()
	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	return snapshot
}

// 取唯一分组的条目数组。
func serviceItems(t *testing.T, snapshot *Snapshot) []any {
	t.Helper()
	groups, ok := snapshot.Raw[FileServices].([]any)
	if !ok || len(groups) == 0 {
		t.Fatalf("服务文档为空：%#v", snapshot.Raw[FileServices])
	}
	group := groups[0].(*orderedMap)
	for _, key := range group.keys {
		if items, isList := group.values[key].([]any); isList {
			return items
		}
	}
	t.Fatalf("分组里没有条目数组：%#v", group)
	return nil
}

// 目录内五份文件的完整快照，用于断言「不落盘」。
func snapshotDirectory(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	files := make(map[string][]byte, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("读取 %s 失败：%v", name, err)
		}
		files[name] = content
	}
	return files
}

// 逐字节比较目录内容未变。
func assertDirectoryUnchanged(t *testing.T, dir string, before map[string][]byte) {
	t.Helper()
	for _, name := range ConfigFileNames {
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("读取 %s 失败：%v", name, err)
		}
		if !bytes.Equal(content, before[name]) {
			t.Errorf("%s 被改动\n原内容：%s\n现内容：%s", name, before[name], content)
		}
	}
}

// 用与生产一致的解析器读 JSON 载荷，保留数字原文。
func parseJSONPayload(t *testing.T, body []byte) (EditableConfigWrite, error) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("测试载荷不是合法 JSON：%v", err)
	}
	return ParseEditableConfigWrite(decoded)
}

// 走完整写回链路：解析载荷后落盘，解析阶段的拒绝不会碰磁盘。
func writeThroughParser(t *testing.T, dir, body string) (*Snapshot, error) {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("测试载荷不是合法 JSON：%v", err)
	}
	payload, err := ParseEditableConfigWrite(decoded)
	if err != nil {
		return nil, err
	}
	return WriteConfig(context.Background(), dir, payload)
}

// 错误链里取配置错误。
func asConfigError(err error, target **EditableConfigError) bool {
	for err != nil {
		if typed, ok := err.(*EditableConfigError); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

// 把可编辑视图转成写回载荷：密钥状态视图统一换成 keep。
func editableViewToWritePayload(t *testing.T, editable EditableConfig) any {
	t.Helper()
	encoded, err := json.Marshal(editable)
	if err != nil {
		t.Fatalf("序列化可编辑视图失败：%v", err)
	}

	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("解析可编辑视图失败：%v", err)
	}
	return replaceSecretViews(decoded)
}

// 递归把 {"status": ...} 换成 {"mode": "keep"}。
func replaceSecretViews(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		if _, isSecretView := typed["status"]; isSecretView && len(typed) == 1 {
			return map[string]any{"mode": "keep"}
		}
		for key, item := range typed {
			typed[key] = replaceSecretViews(item)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = replaceSecretViews(item)
		}
		return typed
	default:
		return value
	}
}

// 每个用例开始前清空故障闸门，避免相互影响。
func resetConfigGate(t *testing.T) {
	t.Helper()
	configGate.close()
	t.Cleanup(func() { configGate.close() })
}
