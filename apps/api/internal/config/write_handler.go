package config

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"github.com/gatecross/homepage/api/internal/httpapi"
)

// PUT 写回的载荷上限：编辑器一次提交五份配置，正常远小于该值。
const maxConfigWriteBodyBytes = 8 << 20

// 关闭请求体失败时的固定文案。
const configBodyUnreadableMessage = "请求体读取失败，请重试"

// 写回响应：只回 ok，不回显任何配置内容。
type ConfigWriteResponse struct {
	OK bool `json:"ok"`
}

// 处理写回请求：解析载荷 → 加写锁 → 合并 → 序列化 → 原子替换 → 刷新快照。
// 非法 JSON 与非法载荷都是 CONFIG_INVALID，且不落盘。
func (h *Handler) ServeConfigWrite(w http.ResponseWriter, r *http.Request) {
	body, err := decodeConfigWriteBody(w, r)
	if err != nil {
		var configErr *EditableConfigError
		if errors.As(err, &configErr) {
			httpapiErrorFor(configErr).Write(w)
			return
		}
		httpapi.ConfigInvalid(err.Error()).Write(w)
		return
	}

	dir := h.configDir()
	if dir == "" {
		// 未注入配置目录时无盘可写，按内部失败处理，绝不落到当前工作目录
		log.Printf("配置写回缺少配置目录，已拒绝")
		writeInternalError(w)
		return
	}

	payload, err := ParseEditableConfigWrite(body)
	if err != nil {
		var configErr *EditableConfigError
		if errors.As(err, &configErr) {
			httpapiErrorFor(configErr).Write(w)
			return
		}
		writeInternalError(w)
		return
	}

	snapshot, err := WriteConfig(r.Context(), dir, payload)
	if err != nil {
		var configErr *EditableConfigError
		if errors.As(err, &configErr) {
			log.Printf("配置写回失败：%s", configErr.Message)
			httpapiErrorFor(configErr).Write(w)
			return
		}
		log.Printf("配置写回失败：%v", err)
		writeInternalError(w)
		return
	}

	// 写回成功即刻换上新快照，不等 fsnotify 的监听事件
	if h.store != nil {
		h.store.Replace(snapshot)
	}
	log.Printf("配置已保存：%s", dir)

	httpapi.WriteJSON(w, http.StatusOK, ConfigWriteResponse{OK: true})
}

// 读取并解析请求体 JSON；解析器保留数字原文，避免大整数与小数被静默改写。
// 空请求体、语法错误与多个 JSON 值都按非法载荷处理。
func decodeConfigWriteBody(w http.ResponseWriter, r *http.Request) (any, error) {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxConfigWriteBodyBytes))
	decoder.UseNumber()

	var body any
	if err := decoder.Decode(&body); err != nil {
		return nil, &EditableConfigError{Message: "请求体必须为 JSON 对象"}
	}
	// 只接受单个 JSON 值，尾随内容一律视为非法
	if err := decoder.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return nil, &EditableConfigError{Message: "请求体必须为单个 JSON 对象"}
	}
	return body, nil
}

// 当前配置目录；未注入时返回空串。
func (h *Handler) configDir() string {
	return h.configDirPath
}
