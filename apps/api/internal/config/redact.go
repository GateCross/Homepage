package config

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
)

// 响应体密钥扫描：发送前确认序列化后的 JSON 不含允许列表里的任何敏感值。
// 出站目标 URL 本身不算敏感值，不参与扫描。

// 收集允许列表中的全部密钥与请求头值，去空去重后按字典序返回。
// 排序只为输出稳定；扫描结果与顺序无关。
func CollectSensitiveValues(allowList *AllowList) []string {
	if allowList == nil {
		return nil
	}

	values := make(map[string]struct{})
	for _, target := range allowList.WidgetTargets {
		for _, secret := range target.Secrets {
			if secret != "" {
				values[secret] = struct{}{}
			}
		}
		for _, headerValue := range headerValues(target.Options) {
			if headerValue != "" {
				values[headerValue] = struct{}{}
			}
		}
	}

	secrets := make([]string, 0, len(values))
	for secret := range values {
		secrets = append(secrets, secret)
	}
	sort.Strings(secrets)
	return secrets
}

// 取出组件选项里的请求头值；选项缺失或形态不符时返回空。
// 不筛请求头名：值为字符串即算敏感，与规范化阶段的对象遍历保持一致。
func headerValues(options any) []string {
	optionsDoc, ok := options.(map[string]any)
	if !ok {
		return nil
	}

	var values []string
	switch headers := optionsDoc["headers"].(type) {
	case map[string]string:
		for _, value := range headers {
			values = append(values, value)
		}
	case map[string]any:
		for _, raw := range headers {
			if value, ok := raw.(string); ok {
				values = append(values, value)
			}
		}
	}
	return values
}

// 判断序列化后的 JSON 是否含任一敏感值；secrets 为空时恒为 false。
// 同时匹配原文与 JSON 转义形式，避免引号、反斜杠与控制字符漏检。
func JSONContainsAnySecret(data []byte, secrets []string) bool {
	for _, secret := range secrets {
		if jsonContainsSecret(data, secret) {
			return true
		}
	}
	return false
}

// 单个敏感值匹配：先比原文，再比 JSON 转义后的形式。
func jsonContainsSecret(data []byte, secret string) bool {
	if secret == "" {
		return false
	}
	if bytes.Contains(data, []byte(secret)) {
		return true
	}
	for _, escaped := range escapeJSONVariants(secret) {
		if escaped != secret && bytes.Contains(data, []byte(escaped)) {
			return true
		}
	}
	return false
}

// 返回敏感值的 JSON 转义内容：既含不转义 HTML 的形态，也含转义 HTML 的形态。
// 响应可能由不同的编码器产出，两种转义都要覆盖，否则同一密钥会因写法不同而漏检。
func escapeJSONVariants(raw string) []string {
	variants := make([]string, 0, 2)
	for _, escapeHTML := range []bool{false, true} {
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(escapeHTML)
		if err := encoder.Encode(raw); err != nil {
			continue
		}
		encoded := strings.TrimSuffix(buffer.String(), "\n")
		if len(encoded) < 2 {
			continue
		}
		variants = append(variants, encoded[1:len(encoded)-1])
	}
	return variants
}
