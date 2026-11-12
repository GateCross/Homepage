// Package httpapi 提供 HTTP 中间件、错误信封、版本端点与路由组装。
package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gatecross/homepage/api/internal/domain"
)

// JSONContentType 是全部 JSON 响应统一使用的 Content-Type。
const JSONContentType = "application/json; charset=utf-8"

// 错误码，取值与前端契约一致。
const (
	CodeConfigInvalid = "CONFIG_INVALID"
	CodeConfigFaulted = "CONFIG_FAULTED"
	CodeForbidden     = "FORBIDDEN"
	CodeNotFound      = "NOT_FOUND"
	CodeExternal      = "EXTERNAL_FAILURE"
	CodeExternalTmo   = "EXTERNAL_TIMEOUT"
	CodeInternal      = "INTERNAL"
)

// 错误码到 HTTP 状态码的映射，未知错误码按 500 处理。
var statusByCode = map[string]int{
	CodeConfigInvalid: http.StatusUnprocessableEntity,
	CodeConfigFaulted: http.StatusInternalServerError,
	CodeForbidden:     http.StatusForbidden,
	CodeNotFound:      http.StatusNotFound,
	CodeExternal:      http.StatusBadGateway,
	CodeExternalTmo:   http.StatusGatewayTimeout,
	CodeInternal:      http.StatusInternalServerError,
}

// Error 是可安全外露的失败响应，构造后直接交给 Write。
type Error struct {
	Status int
	Body   domain.ErrorEnvelope
}

// Error 实现 error，便于中间件把失败响应当错误值向上传递。
func (e *Error) Error() string { return e.Body.Error.Message }

// NewError 按错误码构造失败响应，未识别的错误码回落到 500。
func NewError(code, message string) *Error {
	status, known := statusByCode[code]
	if !known {
		status = http.StatusInternalServerError
	}
	return &Error{
		Status: status,
		Body: domain.ErrorEnvelope{
			Ok:    false,
			Error: domain.PublicError{Message: message, Code: &code},
		},
	}
}

// NotFound 构造 404 信封，用于未知接口。
func NotFound(message string) *Error { return NewError(CodeNotFound, message) }

// Internal 构造 500 信封；默认文案不含任何内部细节。
func Internal(message string) *Error { return NewError(CodeInternal, message) }

// ConfigInvalid 构造 422 信封，用于配置校验失败。
func ConfigInvalid(message string) *Error { return NewError(CodeConfigInvalid, message) }

// Forbidden 构造 403 信封，用于授权拒绝。
func Forbidden(message string) *Error { return NewError(CodeForbidden, message) }

// WithFile 补充配置出错的文件名，用于定位五文件中的具体一份。
func (e *Error) WithFile(file string) *Error {
	e.Body.Error.File = &file
	return e
}

// WithPath 补充配置出错的字段路径。
func (e *Error) WithPath(path string) *Error {
	e.Body.Error.Path = &path
	return e
}

// WithLocation 补充配置出错的行列号，0 表示未知的位置不写入。
func (e *Error) WithLocation(line, column int) *Error {
	if line > 0 {
		e.Body.Error.Line = &line
	}
	if column > 0 {
		e.Body.Error.Column = &column
	}
	return e
}

// Write 输出失败响应；错误响应一律不得被中间缓存。
func (e *Error) Write(w http.ResponseWriter) {
	WriteJSON(w, e.Status, e.Body)
}

// WriteJSON 输出 JSON 响应体，Content-Type 固定为 application/json; charset=utf-8。
func WriteJSON(w http.ResponseWriter, status int, body any) {
	payload, err := json.Marshal(body)
	if err != nil {
		// 序列化失败只可能是响应结构自身有误，退回固定信封而不是吐半截 JSON
		payload = []byte(`{"ok":false,"error":{"message":"响应序列化失败"}}`)
		status = http.StatusInternalServerError
	}
	header := w.Header()
	header.Set("Content-Type", JSONContentType)
	header.Set("Cache-Control", "no-store")
	header.Set("Content-Length", strconv.Itoa(len(payload)))
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// WriteError 是 WriteJSON 的信封快捷方式。
func WriteError(w http.ResponseWriter, e *Error) { e.Write(w) }
