package config

import (
	"bytes"
	"strings"

	"gopkg.in/yaml.v3"
)

// 把合并后的五棵解析树序列化成 YAML 文本。
// 风格与 TS 侧一致：长标量不折行、普通字符串与键都不加引号、数组保持在父键下缩进。

// 单份文档的空文档内容：解析树为 nil 时输出空串，与 TS 的空文档约定一致。
const emptyYAMLDocument = ""

// 序列化五份文档；键为文件名，值与加载顺序一致。
// 任一文档无法安全序列化时返回错误，调用方不得落盘。
func SerializeFiveDocuments(documents map[string]any) (map[string]string, error) {
	texts := make(map[string]string, len(ConfigFileNames))
	for _, name := range ConfigFileNames {
		text, err := serializeYAMLDocument(documents[name], name)
		if err != nil {
			return nil, err
		}
		texts[name] = text
	}
	return texts, nil
}

// 单份文档序列化；空文档返回空串，其余保证以换行收尾。
func serializeYAMLDocument(value any, file string) (string, error) {
	if value == nil {
		return emptyYAMLDocument, nil
	}

	encoded, err := encodeYAMLNode(value)
	if err != nil {
		return "", unserializableFileError(file)
	}

	var buffer bytes.Buffer
	encoder := yaml.NewEncoder(&buffer)
	// 缩进固定 2 格；序列项与分组名同层，和原有配置文件写法一致
	encoder.SetIndent(2)
	if err := encoder.Encode(encoded); err != nil {
		return "", unserializableFileError(file)
	}
	if err := encoder.Close(); err != nil {
		return "", unserializableFileError(file)
	}

	text := buffer.String()
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return text, nil
}

// 把值编码成文档节点再交给编码器：直接编码值会多出一层缩进，
// 包成文档节点才能让顶层映射从第一列开始。
func encodeYAMLNode(value any) (*yaml.Node, error) {
	var body yaml.Node
	if err := body.Encode(value); err != nil {
		return nil, err
	}
	return &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{&body}}, nil
}

// 序列化失败的固定文案，带文件名便于定位。
func unserializableFileError(file string) *EditableConfigError {
	return &EditableConfigError{
		Message: "无法安全序列化配置文件 " + file,
		File:    file,
	}
}
