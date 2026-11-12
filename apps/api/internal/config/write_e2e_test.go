package config_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gatecross/homepage/api/internal/config"
)

// 仓库根下的真实配置目录；不存在时跳过，避免在裁剪过的检出上误报。
const realConfigSourceDir = "../../../../config"

// 端到端：真实配置 → 投影 → 原样回写（密钥一律 keep）→ 再次投影，
// 可编辑视图必须与首次逐字节一致，磁盘五份文件也保持原字节。
func TestRealConfigRoundTripThroughHTTP(t *testing.T) {
	dir := copyRealConfigDirForHTTP(t)

	store := config.NewStore()
	if err := store.Load(dir); err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	handler := config.NewHandler(store).WithConfigDir(dir)

	editable := getBody(t, handler, config.ConfigEditablePath)
	payload := toWritePayload(t, editable)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, config.ConfigPath, strings.NewReader(string(payload))))
	if recorder.Code != http.StatusOK {
		t.Fatalf("写回状态码 = %d：%s", recorder.Code, recorder.Body.String())
	}

	if again := getBody(t, handler, config.ConfigEditablePath); !bytes.Equal(again, editable) {
		t.Errorf("回写后投影结果发生变化\n首次：%s\n二次：%s", editable, again)
	}

	for _, name := range config.ConfigFileNames {
		before, err := os.ReadFile(filepath.Join(realConfigSourceDir, name))
		if err != nil {
			t.Fatalf("读取原文件失败：%v", err)
		}
		after, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("读取写回文件失败：%v", err)
		}
		if !bytes.Equal(before, after) {
			t.Errorf("%s 原样回写后字节发生变化\n写回前：\n%s\n写回后：\n%s", name, before, after)
		}
	}

	// Store 已换成新快照，读端点仍能正常输出
	if title := store.Snapshot().Config.Settings.Title; title == "" {
		t.Error("写回后快照的标题不应为空")
	}
}

// 连续两次原样回写，磁盘五份文件字节必须一致：第二次写回不得再改动内容。
func TestRealConfigDoubleWriteIsStable(t *testing.T) {
	dir := copyRealConfigDirForHTTP(t)

	store := config.NewStore()
	if err := store.Load(dir); err != nil {
		t.Fatalf("加载失败：%v", err)
	}
	handler := config.NewHandler(store).WithConfigDir(dir)

	writeOnce := func() {
		t.Helper()
		editable := getBody(t, handler, config.ConfigEditablePath)
		payload := toWritePayload(t, editable)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, config.ConfigPath, strings.NewReader(string(payload))))
		if recorder.Code != http.StatusOK {
			t.Fatalf("写回状态码 = %d：%s", recorder.Code, recorder.Body.String())
		}
	}

	writeOnce()
	first := make(map[string][]byte, len(config.ConfigFileNames))
	for _, name := range config.ConfigFileNames {
		first[name] = mustReadFile(t, filepath.Join(dir, name))
	}

	writeOnce()
	for _, name := range config.ConfigFileNames {
		if current := mustReadFile(t, filepath.Join(dir, name)); !bytes.Equal(current, first[name]) {
			t.Errorf("%s 第二次写回后字节变化\n首次：\n%s\n二次：\n%s", name, first[name], current)
		}
	}
}

// 直接读一份文件，读取失败终止用例。
func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 %s 失败：%v", path, err)
	}
	return content
}

// 复制真实配置目录，缺失任一份就跳过。
func copyRealConfigDirForHTTP(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range config.ConfigFileNames {
		content, err := os.ReadFile(filepath.Join(realConfigSourceDir, name))
		if err != nil {
			t.Skipf("跳过：读取原配置 %s 失败（%v）", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
			t.Fatalf("写入 %s 失败：%v", name, err)
		}
	}
	return dir
}

// 发一次请求并返回响应体。
func getBody(t *testing.T, handler http.Handler, path string) []byte {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("%s 状态码 = %d：%s", path, recorder.Code, recorder.Body.String())
	}
	return recorder.Body.Bytes()
}

// 把可编辑视图转成写回载荷：状态视图统一换成 keep 指令。
func toWritePayload(t *testing.T, editable []byte) []byte {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(editable))
	decoder.UseNumber()
	var view any
	if err := decoder.Decode(&view); err != nil {
		t.Fatalf("解析可编辑视图失败：%v", err)
	}
	payload, err := json.Marshal(replaceSecretViewsWithKeep(view))
	if err != nil {
		t.Fatalf("序列化写回载荷失败：%v", err)
	}
	return payload
}

// 递归把 {"status": ...} 换成 {"mode": "keep"}。
func replaceSecretViewsWithKeep(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		if _, isSecretView := typed["status"]; isSecretView && len(typed) == 1 {
			return map[string]any{"mode": "keep"}
		}
		for key, item := range typed {
			typed[key] = replaceSecretViewsWithKeep(item)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = replaceSecretViewsWithKeep(item)
		}
		return typed
	default:
		return value
	}
}
