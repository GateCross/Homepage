package config

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/gatecross/homepage/api/internal/domain"
)

// YAML 解码后的常见形态收敛工具：映射、序列、标量各有固定回退值。

// orderedMap 保留键的声明顺序；分组索引与稳定 ID 依赖该顺序。
type orderedMap struct {
	keys   []string
	values map[string]any
}

func newOrderedMap(capacity int) *orderedMap {
	return &orderedMap{keys: make([]string, 0, capacity), values: make(map[string]any, capacity)}
}

func (m *orderedMap) set(key string, value any) {
	if _, exists := m.values[key]; !exists {
		m.keys = append(m.keys, key)
	}
	m.values[key] = value
}

// 序列化时按声明顺序输出键，供写回与调试保持与原文件一致的顺序。
func (m *orderedMap) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	for i, key := range m.keys {
		if i > 0 {
			buffer.WriteByte(',')
		}
		encodedKey, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		encodedValue, err := json.Marshal(m.values[key])
		if err != nil {
			return nil, err
		}
		buffer.Write(encodedKey)
		buffer.WriteByte(':')
		buffer.Write(encodedValue)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

// 写回 YAML 时同样按声明顺序输出键。
func (m *orderedMap) MarshalYAML() (any, error) {
	node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, key := range m.keys {
		keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
		var valueNode yaml.Node
		if err := valueNode.Encode(m.values[key]); err != nil {
			return nil, err
		}
		node.Content = append(node.Content, keyNode, &valueNode)
	}
	return node, nil
}

// 映射统一取底层字典；*orderedMap 与 map[string]any 都接受。
func asMapOK(raw any) (map[string]any, bool) {
	switch doc := raw.(type) {
	case *orderedMap:
		return doc.values, true
	case map[string]any:
		return doc, true
	default:
		return nil, false
	}
}

func asMap(raw any) map[string]any {
	doc, ok := asMapOK(raw)
	if !ok {
		return map[string]any{}
	}
	return doc
}

// 按声明顺序返回键；无序映射退回字典序，保证输出稳定。
func mapKeysInOrder(raw any) []string {
	switch doc := raw.(type) {
	case *orderedMap:
		return doc.keys
	case map[string]any:
		keys := make([]string, 0, len(doc))
		for key := range doc {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return keys
	default:
		return nil
	}
}

func asSlice(raw any) []any {
	if list, ok := raw.([]any); ok {
		return list
	}
	return nil
}

// 接受整数与可整除的浮点；其它形态视为缺失。
func asInt(raw any) (int, bool) {
	switch value := raw.(type) {
	case int:
		return value, true
	case int64:
		return int(value), true
	case float64:
		if value != float64(int(value)) {
			return 0, false
		}
		return int(value), true
	default:
		return 0, false
	}
}

// 非有限值（NaN、Inf）不算有效权重，与前端的一致性校验对齐。
func asFloat(raw any) (float64, bool) {
	switch value := raw.(type) {
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return value, true
	default:
		return 0, false
	}
}

// 去空白后非空才返回文本。
func nonEmptyString(raw any) string {
	text, ok := raw.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

// 仅四种窗口目标安全，其余一律回落 _blank。
var safeTargets = map[string]struct{}{
	"_blank":  {},
	"_self":   {},
	"_parent": {},
	"_top":    {},
}

func normalizeTarget(raw any) string {
	const defaultTarget = "_blank"
	target := nonEmptyString(raw)
	if _, safe := safeTargets[target]; !safe {
		return defaultTarget
	}
	return target
}

// 规范化绝对 http(s) URL；非法输入返回空串。
func normalizeHref(raw string) string {
	return domain.NormalizeAbsoluteHTTPURL(raw)
}

// 去首尾空白并转小写，用于类型标记。
func normalizeTypeToken(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

// 仅当整值为 ${ENV_VAR} 时返回变量名。
func envPlaceholderName(raw string) (string, bool) {
	if len(raw) < 4 || !strings.HasPrefix(raw, "${") || !strings.HasSuffix(raw, "}") {
		return "", false
	}
	name := raw[2 : len(raw)-1]
	if name == "" {
		return "", false
	}
	for _, r := range name {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' {
			return "", false
		}
	}
	return name, true
}
