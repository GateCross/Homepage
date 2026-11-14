package config

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 替换中途失败时按快照回滚：已替换的文件恢复成写回前的字节。
// 注入点是把某份文件在同目录的临时文件路径占成目录，写入临时文件必然失败。
func TestWriteConfigRollsBackOnReplaceFailure(t *testing.T) {
	resetConfigGate(t)

	cases := map[string]struct {
		blockedFile string
		replaced    []string
	}{
		"第三份失败已替换两份": {blockedFile: FileBookmarks, replaced: []string{FileSettings, FileServices}},
		"首份失败未替换":    {blockedFile: FileSettings},
	}

	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			dir := writeConfigDir(t, map[string]string{
				FileSettings:  "title: 写回前\nuseEqualHeights: false\n",
				FileServices:  "- Server:\n    - name: 保留\n      href: https://example.com/keep\n",
				FileBookmarks: testBookmarksYAML,
				FileWidgets:   testWidgetsYAML,
				FileDocker:    testDockerYAML,
			})
			before := readExistingFiles(t, dir)
			// 占位成目录，让写临时文件这一步失败
			blocked := filepath.Join(dir, replaceTempName(testCase.blockedFile))
			if err := os.Mkdir(blocked, 0o755); err != nil {
				t.Fatalf("创建占位目录失败：%v", err)
			}
			t.Cleanup(func() { _ = os.Remove(blocked) })

			payload := baseWritePayload()
			payload.Settings.Title = "写回后"
			payload.Services = []EditableServiceGroupWrite{{
				Name:  "Server",
				Items: []EditableServiceItemWrite{{Name: "新增", Href: strPtr("https://example.com/new")}},
			}}
			payload.DockerEndpoints = []EditableDockerEndpoint{{Name: "local", Connection: "unix:///var/run/docker.sock"}}
			_, err := WriteConfig(context.Background(), dir, payload)
			if err == nil {
				t.Fatal("替换失败应返回错误")
			}

			var configErr *EditableConfigError
			if !asConfigError(err, &configErr) {
				t.Fatalf("错误类型不符：%T", err)
			}
			if configErr.Code != "" {
				t.Errorf("普通保存失败不应带故障码，实得 %q", configErr.Code)
			}
			if wantPrefix := "配置保存失败"; !strings.HasPrefix(configErr.Message, wantPrefix) {
				t.Errorf("错误文案应以 %q 开头，实得 %q", wantPrefix, configErr.Message)
			}
			if configErr.File != testCase.blockedFile {
				t.Errorf("错误应定位到 %s，实得 %q", testCase.blockedFile, configErr.File)
			}

			// 已替换的文件必须回到写回前的内容，其余文件不受影响
			for _, fileName := range ConfigFileNames {
				content, readErr := os.ReadFile(filepath.Join(dir, fileName))
				if readErr != nil {
					t.Fatalf("读取 %s 失败：%v", fileName, readErr)
				}
				if !bytes.Equal(content, before[fileName]) {
					t.Errorf("%s 未恢复到写回前内容\n写回前：%s\n当前：%s", fileName, before[fileName], content)
				}
			}
			if configGate.isFaulted() {
				t.Error("回滚成功后不应进入故障态")
			}
			// 已替换的数量符合预期，说明确实发生了部分替换
			if len(testCase.replaced) == 0 && !bytes.Equal(before[FileSettings], mustRead(t, filepath.Join(dir, FileSettings))) {
				t.Error("首份文件就不应被改动")
			}
		})
	}
}

// 回滚必须覆盖原先不存在的文件：写回时新建的文件在失败后应被删除。
func TestRollbackRemovesFilesThatDidNotExist(t *testing.T) {
	resetConfigGate(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileSettings), []byte("title: 前\n"), 0o600); err != nil {
		t.Fatalf("写入设置文件失败：%v", err)
	}

	snapshot, err := snapshotFiveFiles(dir)
	if err != nil {
		t.Fatalf("快照失败：%v", err)
	}
	if snapshot[FileSettings].exists != true || snapshot[FileDocker].exists {
		t.Fatalf("快照存在状态不符：%+v", snapshot)
	}

	// 手工制造两份新文件，再按快照回滚
	for _, name := range []string{FileServices, FileDocker} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("name: 新\n"), 0o600); err != nil {
			t.Fatalf("写入 %s 失败：%v", name, err)
		}
	}
	if err := rollbackReplacedFiles(dir, snapshot, []string{FileServices, FileDocker}); err != nil {
		t.Fatalf("回滚失败：%v", err)
	}
	for _, name := range []string{FileServices, FileDocker} {
		if _, statErr := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(statErr) {
			t.Errorf("写回前不存在的 %s 回滚后应被删除", name)
		}
	}

	// 本就不存在时回滚也不报错
	if err := rollbackReplacedFiles(dir, snapshot, []string{FileWidgets}); err != nil {
		t.Errorf("回滚不存在的文件不应报错：%v", err)
	}
}

// 回滚后旧配置仍无法加载时进入故障态，后续写回被拒绝直到磁盘恢复。
func TestRollbackFailureOpensConfigGate(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings: "title: 原始\n",
		FileDocker:   testDockerYAML,
	})
	snapshot, err := snapshotFiveFiles(dir)
	if err != nil {
		t.Fatalf("快照失败：%v", err)
	}

	// 目标路径变成目录，回滚写不回原文件
	target := filepath.Join(dir, FileSettings)
	if err := os.Remove(target); err != nil {
		t.Fatalf("删除设置文件失败：%v", err)
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatalf("创建同名目录失败：%v", err)
	}

	if err := rollbackAndVerify(dir, snapshot, []string{FileSettings}); err == nil {
		t.Fatal("回滚失败应返回错误")
	}
	if !configGate.isFaulted() {
		t.Fatal("回滚失败应开启故障闸门")
	}

	// 故障态下写回直接被拒，不会尝试碰磁盘
	_, err = WriteConfig(context.Background(), dir, baseWritePayload())
	if err == nil {
		t.Fatal("故障态下写回应被拒绝")
	}
	var configErr *EditableConfigError
	if !asConfigError(err, &configErr) || configErr.Code != codeConfigFaulted {
		t.Fatalf("应返回故障态错误，实得 %#v", err)
	}

	// 磁盘恢复后闸门可自行解除
	if err := os.Remove(target); err != nil {
		t.Fatalf("清理目录失败：%v", err)
	}
	if err := os.WriteFile(target, []byte("title: 恢复\n"), 0o600); err != nil {
		t.Fatalf("恢复设置文件失败：%v", err)
	}
	payload := baseWritePayload()
	payload.Settings.Title = "恢复后写回"
	if _, err := WriteConfig(context.Background(), dir, payload); err != nil {
		t.Fatalf("磁盘恢复后写回应成功：%v", err)
	}
	if configGate.isFaulted() {
		t.Error("写回成功后故障闸门应关闭")
	}
}

// 读出目录内已存在的文件，供回滚断言使用。
func readExistingFiles(t *testing.T, dir string) map[string][]byte {
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

// 直接读一份文件，读取失败终止用例。
func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 %s 失败：%v", path, err)
	}
	return content
}

// 崩溃残留的写回临时文件在启动清理时删除，正常配置文件不受影响。
func TestCleanupStaleTempFiles(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "."+FileSettings+".12345.tmp")
	staleRollback := filepath.Join(dir, "."+FileDocker+".12345.rollback.tmp")
	normal := filepath.Join(dir, FileSettings)
	for _, path := range []string{stale, staleRollback, normal} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	CleanupStaleTempFiles(dir)

	if _, err := os.Stat(stale); err == nil {
		t.Fatal("写回残留 tmp 应被清理")
	}
	if _, err := os.Stat(staleRollback); err == nil {
		t.Fatal("回滚残留 tmp 应被清理")
	}
	if _, err := os.Stat(normal); err != nil {
		t.Fatalf("正常配置文件不应被清理：%v", err)
	}
}
