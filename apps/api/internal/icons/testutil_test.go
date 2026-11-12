package icons

import (
	"net/http"
	"path/filepath"
	"testing"
)

// 最小 PNG 字节：只给魔数加一段填充，足够通过魔数校验。
func testPNG(payload string) []byte {
	return append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, []byte(payload)...)
}

// 最小 ICO 字节。
func testICO(payload string) []byte {
	return append([]byte{0x00, 0x00, 0x01, 0x00}, []byte(payload)...)
}

// 构造指向本地假站点的服务：落盘目录落在临时目录，出网客户端沿用取图默认策略。
func newTestService(t *testing.T, options Options) *Service {
	t.Helper()
	if options.ImagesDir == "" {
		options.ImagesDir = filepath.Join(t.TempDir(), "images")
	}
	if options.Client == nil {
		options.Client = newFetchClient()
	}
	return NewService(options)
}

// 直接以字节响应，避免每个用例都重复写头。
func writeBytes(w http.ResponseWriter, contentType string, body []byte) {
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// 以固定状态码响应，空体。
func writeStatus(w http.ResponseWriter, status int) {
	w.WriteHeader(status)
}
