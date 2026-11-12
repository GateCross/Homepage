package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// 仓库根下的真实配置目录，用于「现有配置」的序列化幂等回归。
const realConfigDir = "../../../../config"

// 序列化幂等：读入现有配置 → 序列化 → 再解析 → 与原结构深比较相等。
func TestSerializeRoundTripKeepsParseTree(t *testing.T) {
	t.Parallel()
	dir := copyRealConfigDir(t)

	originals := readParseTrees(t, dir)
	texts, err := SerializeFiveDocuments(originals)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}

	for _, name := range ConfigFileNames {
		reparsed, err := decodeYAML([]byte(texts[name]))
		if err != nil {
			t.Fatalf("重新解析 %s 失败：%v\n%s", name, err, texts[name])
		}
		if !deepEqualConfigValue(originals[name], reparsed) {
			t.Errorf("%s 序列化后结构改变\n原文：%v\n序列化：\n%s", name, originals[name], texts[name])
		}
	}
}

// 同一棵解析树连续序列化两次，文本必须逐字节一致，且写回后再读仍是同一份结构。
func TestSerializeIsStableAcrossRuns(t *testing.T) {
	t.Parallel()
	dir := copyRealConfigDir(t)
	originals := readParseTrees(t, dir)

	first, err := SerializeFiveDocuments(originals)
	if err != nil {
		t.Fatalf("首次序列化失败：%v", err)
	}
	second, err := SerializeFiveDocuments(originals)
	if err != nil {
		t.Fatalf("二次序列化失败：%v", err)
	}
	for _, name := range ConfigFileNames {
		if first[name] != second[name] {
			t.Errorf("%s 两次序列化结果不一致", name)
		}
	}
}

// 现有配置序列化后应逐字节复现原文件：缩进、键序与引号风格都不走样。
func TestSerializeRealConfigMatchesSourceBytes(t *testing.T) {
	t.Parallel()
	dir := copyRealConfigDir(t)

	texts, err := SerializeFiveDocuments(readParseTrees(t, dir))
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	for _, name := range ConfigFileNames {
		sourceBytes, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("读取 %s 失败：%v", name, err)
		}
		if texts[name] != string(sourceBytes) {
			t.Errorf("%s 序列化结果与原文件不一致\n原文件：\n%s\n序列化：\n%s", name, sourceBytes, texts[name])
		}
	}
}

// 序列化风格：普通字符串与键都不加引号，长文本不折行。
func TestSerializeStyleMatchesTS(t *testing.T) {
	t.Parallel()

	root := newOrderedMap(4)
	root.set("title", "HomePage")
	root.set("emptyMap", newOrderedMap(0))
	root.set("emptyList", []any{})

	layout := newOrderedMap(1)
	group := newOrderedMap(2)
	group.set("style", "row")
	group.set("columns", 6)
	layout.set("Server", group)
	root.set("layout", layout)

	longText := "很长的普通字符串用来确认序列化不会折行，普通字符串也不加引号，长文本同样不加引号并且保持单行输出"
	items := []any{}
	item := newOrderedMap(2)
	item.set("name", longText)
	item.set("maxBookmarkGroupColumns", nil)
	items = append(items, item)
	root.set("services", items)

	documents := map[string]any{
		FileSettings:  root,
		FileServices:  nil,
		FileBookmarks: []any{},
		FileWidgets:   []any{},
		FileDocker:    newOrderedMap(0),
	}
	texts, err := SerializeFiveDocuments(documents)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}

	settings := texts[FileSettings]
	for _, want := range []string{
		"title: HomePage\n",
		"emptyMap: {}\n",
		"emptyList: []\n",
		"  Server:\n    style: row\n    columns: 6\n",
		"    maxBookmarkGroupColumns: null\n",
		"  - name: " + longText + "\n",
	} {
		if !strings.Contains(settings, want) {
			t.Errorf("设置段缺少片段 %q：\n%s", want, settings)
		}
	}
	if texts[FileServices] != emptyYAMLDocument {
		t.Errorf("空文档应输出空串，实得 %q", texts[FileServices])
	}
	if texts[FileBookmarks] != "[]\n" {
		t.Errorf("空数组文档应输出 []，实得 %q", texts[FileBookmarks])
	}
	if texts[FileDocker] != "{}\n" {
		t.Errorf("空映射文档应输出 {}，实得 %q", texts[FileDocker])
	}
}

// 复制真实配置目录；目录不存在时跳过，避免在裁剪过的检出上误报。
func copyRealConfigDir(t *testing.T) string {
	t.Helper()
	if _, err := os.Stat(realConfigDir); err != nil {
		t.Skipf("跳过：未找到仓库配置目录 %s", realConfigDir)
	}
	dir := t.TempDir()
	for _, name := range ConfigFileNames {
		content, err := os.ReadFile(filepath.Join(realConfigDir, name))
		if err != nil {
			t.Fatalf("读取 %s 失败：%v", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
			t.Fatalf("写入 %s 失败：%v", name, err)
		}
	}
	return dir
}

// 读出五份解析树，缺失文件视为空文档。
func readParseTrees(t *testing.T, dir string) map[string]any {
	t.Helper()
	trees := make(map[string]any, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("读取 %s 失败：%v", name, err)
		}
		value, err := decodeYAML(content)
		if err != nil {
			t.Fatalf("解析 %s 失败：%v", name, err)
		}
		trees[name] = value
	}
	return trees
}

// 结构深比较：映射要键序与值都一致，序列逐项一致，标量按值与类型一致。
func deepEqualConfigValue(left, right any) bool {
	switch leftValue := left.(type) {
	case *orderedMap:
		rightValue, ok := right.(*orderedMap)
		if !ok || !reflect.DeepEqual(leftValue.keys, rightValue.keys) {
			return false
		}
		for _, key := range leftValue.keys {
			if !deepEqualConfigValue(leftValue.values[key], rightValue.values[key]) {
				return false
			}
		}
		return true
	case []any:
		rightValue, ok := right.([]any)
		if !ok || len(leftValue) != len(rightValue) {
			return false
		}
		for index := range leftValue {
			if !deepEqualConfigValue(leftValue[index], rightValue[index]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(left, right)
	}
}
