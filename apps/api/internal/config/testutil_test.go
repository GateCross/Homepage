package config

import (
	"encoding/json"
	"testing"
)

// 测试共用的 JSON 视图读取工具：按契约里的键名取值，键名写错会直接失败。

func decodeJSONMap(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("响应不是合法 JSON 对象：%v", err)
	}
	return decoded
}

func childMap(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := parent[key]
	if !ok {
		t.Fatalf("缺少字段 %q，实际键：%v", key, keysOf(parent))
	}
	child, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("字段 %q 不是对象：%T", key, value)
	}
	return child
}

func childList(t *testing.T, parent map[string]any, key string) []any {
	t.Helper()
	value, ok := parent[key]
	if !ok {
		t.Fatalf("缺少字段 %q，实际键：%v", key, keysOf(parent))
	}
	list, ok := value.([]any)
	if !ok {
		t.Fatalf("字段 %q 不是数组：%T", key, value)
	}
	return list
}

func listMapAt(t *testing.T, list []any, index int) map[string]any {
	t.Helper()
	if index < 0 || index >= len(list) {
		t.Fatalf("索引 %d 越界，数组长度 %d", index, len(list))
	}
	item, ok := list[index].(map[string]any)
	if !ok {
		t.Fatalf("第 %d 项不是对象：%T", index, list[index])
	}
	return item
}

func keysOf(parent map[string]any) []string {
	keys := make([]string, 0, len(parent))
	for key := range parent {
		keys = append(keys, key)
	}
	return keys
}
