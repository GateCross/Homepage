package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testDockerYAML = "my-docker: unix:///var/run/docker.sock\nremote: https://10.0.0.2:2376\n"

const testServicesYAML = `
- Server:
    - name: PVE
      href: https://192.168.50.100:8006/
      siteMonitor: https://192.168.50.100:8006
    - name: qBittorrent
      href: http://192.168.50.10:8080
      server: my-docker
      container: qbittorrent
      widget:
        type: qbittorrent
        url: http://192.168.50.10:8080
        username: admin
        password: ${QBIT_TEST_PASSWORD}
    - name: 离线服务
      href: http://192.168.50.10:9999
      server: my-docker
      container: offline
    - name: 未声明端点
      href: http://192.168.50.10:9998
      server: missing
      container: x
`

const testWidgetsYAML = `
- type: datetime
  timezone: Asia/Shanghai
- type: openmeteo
  cityId: "101270401"
  location: 绵阳
- type: resources
  cpu: true
  disk: /
`

const testBookmarksYAML = `
- PT:
    - name: HDSky
      href: https://hdsky.me/
`

// 写入一份临时配置目录，contents 中未给出的文件视为缺失。
func writeConfigDir(t *testing.T, contents map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range contents {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("写入 %s 失败：%v", name, err)
		}
	}
	return dir
}

func TestLoadBuildsSnapshot(t *testing.T) {
	t.Setenv("QBIT_TEST_PASSWORD", "secret-value")
	dir := writeConfigDir(t, map[string]string{
		FileServices:  testServicesYAML,
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})

	snapshot, err := Load(dir)
	if err != nil {
		t.Fatalf("加载配置失败：%v", err)
	}

	if len(snapshot.Raw) != len(ConfigFileNames) {
		t.Fatalf("原始文档应保留五份，得到 %d", len(snapshot.Raw))
	}
	if _, ok := snapshot.Raw[FileSettings]; !ok {
		t.Error("缺失文件也应登记为空文档")
	}

	endpoint, ok := snapshot.AllowList.DockerEndpoints["my-docker"]
	if !ok || endpoint.Kind != DockerEndpointUnix || endpoint.SocketPath != "/var/run/docker.sock" {
		t.Fatalf("docker 端点解析不符合预期：%+v", endpoint)
	}
	if remote := snapshot.AllowList.DockerEndpoints["remote"]; !remote.TLS || remote.Port != 2376 {
		t.Fatalf("tcp 端点应按 https 解析：%+v", remote)
	}

	if _, ok := snapshot.AllowList.DockerContainers[DockerContainerKey("my-docker", "qbittorrent")]; !ok {
		t.Error("services 中的 server+container 应登记进允许列表")
	}
	if _, ok := snapshot.AllowList.DockerContainers[DockerContainerKey("missing", "x")]; ok {
		t.Error("未在 docker.yaml 声明的端点不得登记容器")
	}

	var widgetID string
	for id, target := range snapshot.AllowList.WidgetTargets {
		widgetID = id
		if target.Secrets["password"] != "secret-value" {
			t.Errorf("环境变量插值应写入允许列表，得到 %q", target.Secrets["password"])
		}
	}
	if widgetID == "" {
		t.Fatal("受支持的组件应登记服务端目标")
	}

	// 原始文档保留占位符，写回时不得落明文
	rawServices, err := json.Marshal(snapshot.Raw[FileServices])
	if err != nil {
		t.Fatalf("序列化原始文档失败：%v", err)
	}
	if strings.Contains(string(rawServices), "secret-value") {
		t.Error("原始文档不得包含插值后的密钥明文")
	}
	if !strings.Contains(string(rawServices), "${QBIT_TEST_PASSWORD}") {
		t.Error("原始文档应保留环境变量占位符")
	}

	if len(snapshot.Config.Bookmarks) != 1 || len(snapshot.Config.Bookmarks[0].Items) != 1 {
		t.Fatalf("书签分组缺失：%+v", snapshot.Config.Bookmarks)
	}
	bookmark, ok := snapshot.Config.Bookmarks[0].Items[0].(BookmarkJSON)
	if !ok || bookmark.ID == "" {
		t.Fatalf("书签应带稳定 ID：%+v", snapshot.Config.Bookmarks[0].Items[0])
	}

	if len(snapshot.Config.InfoWidgets) != 3 {
		t.Fatalf("信息组件数量不符：%d", len(snapshot.Config.InfoWidgets))
	}
	for _, widget := range snapshot.Config.InfoWidgets {
		if widget.InfoID == "" {
			t.Errorf("信息组件应补 infoId：%+v", widget)
		}
		if _, ok := snapshot.AllowList.InfoTargets[widget.InfoID]; !ok {
			t.Errorf("受支持类型应登记服务端目标：%s", widget.Type)
		}
	}
}

func TestLoadAllMissingReturnsEmptySnapshot(t *testing.T) {
	snapshot, err := Load(t.TempDir())
	if err != nil {
		t.Fatalf("全部缺失不应报错：%v", err)
	}
	if len(snapshot.Config.Services) != 0 || len(snapshot.Config.Bookmarks) != 0 || len(snapshot.Config.InfoWidgets) != 0 {
		t.Fatalf("空目录应得到空配置：%+v", snapshot.Config)
	}
	if snapshot.Config.Settings.Title == "" {
		t.Error("设置应有默认标题")
	}
	if len(snapshot.AllowList.DockerEndpoints) != 0 {
		t.Error("空目录不应登记 docker 端点")
	}
}

func TestLoadRejectsBrokenYAML(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{FileServices: "- name: [未闭合\n"})
	if _, err := Load(dir); err == nil {
		t.Fatal("YAML 语法错误应返回错误")
	}
}

func TestStoreKeepsOldSnapshotOnReloadFailure(t *testing.T) {
	dir := writeConfigDir(t, map[string]string{FileDocker: testDockerYAML})

	store := NewStore()
	if err := store.Load(dir); err != nil {
		t.Fatalf("首次加载失败：%v", err)
	}
	if _, ok := store.Snapshot().AllowList.DockerEndpoints["my-docker"]; !ok {
		t.Fatal("首次加载应登记端点")
	}

	if err := os.WriteFile(filepath.Join(dir, FileDocker), []byte("my-docker: [坏掉的\n"), 0o600); err != nil {
		t.Fatalf("写入损坏配置失败：%v", err)
	}
	if err := store.Load(dir); err == nil {
		t.Fatal("损坏配置应返回错误")
	}
	if _, ok := store.Snapshot().AllowList.DockerEndpoints["my-docker"]; !ok {
		t.Error("重新加载失败时必须保留旧快照")
	}
}

func TestParseDockerEndpoint(t *testing.T) {
	valid := map[string]DockerEndpoint{
		"unix:///var/run/docker.sock": {Kind: DockerEndpointUnix, SocketPath: "/var/run/docker.sock"},
		"tcp://10.0.0.2:2375":         {Kind: DockerEndpointTCP, Host: "10.0.0.2", Port: 2375},
		"https://host:2376/path":      {Kind: DockerEndpointTCP, Host: "host", Port: 2376, TLS: true},
		"tcp://[::1]:2375":            {Kind: DockerEndpointTCP, Host: "::1", Port: 2375},
	}
	for raw, want := range valid {
		got, ok := ParseDockerEndpoint(raw)
		if !ok || got != want {
			t.Errorf("%s 解析结果不符：%+v", raw, got)
		}
	}

	invalid := []string{"", "unix:///", "unix:relative", "tcp://host", "tcp://host:0", "tcp://host:70000", "http://host:2375", "tcp://ho st:2375"}
	for _, raw := range invalid {
		if _, ok := ParseDockerEndpoint(raw); ok {
			t.Errorf("%q 不应被解析为端点", raw)
		}
	}
}
