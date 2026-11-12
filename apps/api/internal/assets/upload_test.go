package assets

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 最小合法 PNG 字节：只带签名与若干填充，魔数校验只看文件头。
func testPNG() []byte {
	body := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	return append(body, bytes.Repeat([]byte{0x00}, 124)...)
}

// 构造一次 multipart 请求体：声明字段名 file，MIME 为空时不写 Content-Type。
func multipartRequest(t *testing.T, filename, contentType string, content []byte) *http.Request {
	t.Helper()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	header := textproto.MIMEHeader{}
	disposition := `form-data; name="file"; filename="` + filename + `"`
	header.Set("Content-Disposition", disposition)
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("构造 multipart 分段失败：%v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("写入分段内容失败：%v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("结束 multipart 写入失败：%v", err)
	}

	request := httptest.NewRequest(http.MethodPost, UploadPath, body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

// 发一次上传请求，返回状态码与已解码的响应体。
func upload(t *testing.T, handler http.Handler, request *http.Request) (int, map[string]any) {
	t.Helper()

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON：%s", recorder.Body.String())
	}
	return recorder.Code, payload
}

// 取错误信封里的文案与错误码。
func errorOf(t *testing.T, payload map[string]any) (message, code string) {
	t.Helper()

	ok, exists := payload["ok"].(bool)
	if !exists || ok {
		t.Fatalf("错误响应的 ok 必须为 false：%v", payload)
	}
	envelope, exists := payload["error"].(map[string]any)
	if !exists {
		t.Fatalf("响应缺少 error 字段：%v", payload)
	}
	message, _ = envelope["message"].(string)
	code, _ = envelope["code"].(string)
	return message, code
}

// images 目录下现有的文件名，目录不存在时视为空。
func imageEntries(t *testing.T, configDir string) []string {
	t.Helper()

	entries, err := os.ReadDir(filepath.Join(configDir, "images"))
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// 合法图片落盘到 images 目录，响应字段与前端契约一致。
func TestUploadStoresImage(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)
	content := testPNG()

	status, payload := upload(t, handler, multipartRequest(t, "My Photo.PNG", "image/png", content))
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200：%v", status, payload)
	}

	if ok, _ := payload["ok"].(bool); !ok {
		t.Fatalf("成功响应的 ok 必须为 true：%v", payload)
	}
	filename, _ := payload["filename"].(string)
	publicPath, _ := payload["path"].(string)

	if !strings.HasSuffix(filename, ".png") {
		t.Fatalf("文件名 = %q，应以 .png 结尾", filename)
	}
	// 原名清洗后转小写，空格转 -，并追加时间戳与随机尾缀
	if !strings.HasPrefix(filename, "my-photo-") {
		t.Fatalf("文件名 = %q，应保留清洗后的原名前缀 my-photo-", filename)
	}
	if publicPath != "/images/"+filename {
		t.Fatalf("路径 = %q，期望 /images/%s", publicPath, filename)
	}

	stored, err := os.ReadFile(filepath.Join(configDir, "images", filename))
	if err != nil {
		t.Fatalf("落盘文件读取失败：%v", err)
	}
	if !bytes.Equal(stored, content) {
		t.Fatalf("落盘内容与上传字节不一致")
	}
}

// 内容不是图片时即使扩展名与声明类型都写 png，也必须拒绝且不落盘。
func TestUploadRejectsForgedExtension(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)

	status, payload := upload(t, handler,
		multipartRequest(t, "evil.png", "image/png", []byte("这不是 PNG，只是一段文本")))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("状态码 = %d，期望 422：%v", status, payload)
	}

	message, code := errorOf(t, payload)
	if code != "CONFIG_INVALID" {
		t.Fatalf("错误码 = %q，期望 CONFIG_INVALID", code)
	}
	if message != msgContentMismatch {
		t.Fatalf("错误文案 = %q，期望 %q", message, msgContentMismatch)
	}
	if names := imageEntries(t, configDir); len(names) != 0 {
		t.Fatalf("被拒绝的上传不得落盘，实际写入：%v", names)
	}
}

// 声明 MIME 是图片但原文件名后缀是另一类时，按声明 MIME 判扩展名，内容不符同样拒绝。
func TestUploadRejectsMismatchedDeclaredType(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)

	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	status, payload := upload(t, handler, multipartRequest(t, "mark.svg", "image/png", svg))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("状态码 = %d，期望 422：%v", status, payload)
	}
	if _, code := errorOf(t, payload); code != "CONFIG_INVALID" {
		t.Fatalf("错误码 = %q，期望 CONFIG_INVALID", code)
	}
	if names := imageEntries(t, configDir); len(names) != 0 {
		t.Fatalf("被拒绝的上传不得落盘，实际写入：%v", names)
	}
}

// 超过 5MB 的图片被拒绝，且不落盘。
func TestUploadRejectsOversize(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)

	oversize := make([]byte, MaxUploadBytes+1)
	copy(oversize, testPNG())

	status, payload := upload(t, handler, multipartRequest(t, "huge.png", "image/png", oversize))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("状态码 = %d，期望 422：%v", status, payload)
	}
	message, code := errorOf(t, payload)
	if code != "CONFIG_INVALID" || message != msgTooLarge {
		t.Fatalf("错误 = (%q, %q)，期望 (%q, CONFIG_INVALID)", message, code, msgTooLarge)
	}
	if names := imageEntries(t, configDir); len(names) != 0 {
		t.Fatalf("被拒绝的上传不得落盘，实际写入：%v", names)
	}
}

// 声明长度明显超限时不读取请求体，直接按超限拒绝。
func TestUploadRejectsDeclaredOversize(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)

	request := multipartRequest(t, "huge.png", "image/png", testPNG())
	request.ContentLength = MaxUploadBytes + uploadOverhead + 1

	status, payload := upload(t, handler, request)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("状态码 = %d，期望 422：%v", status, payload)
	}
	if message, _ := errorOf(t, payload); message != msgTooLarge {
		t.Fatalf("错误文案 = %q，期望 %q", message, msgTooLarge)
	}
}

// 字段名不是 file 时视为未选择文件。
func TestUploadRejectsMissingField(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)

	request := multipartRequest(t, "logo.png", "image/png", testPNG())
	// 改掉字段名，内容仍是一份合法 PNG
	body := strings.Replace(requestBody(t, request), `name="file"`, `name="image"`, 1)
	replaced := httptest.NewRequest(http.MethodPost, UploadPath, strings.NewReader(body))
	replaced.Header.Set("Content-Type", request.Header.Get("Content-Type"))

	status, payload := upload(t, handler, replaced)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("状态码 = %d，期望 422：%v", status, payload)
	}
	if message, _ := errorOf(t, payload); message != msgFileFieldMissing {
		t.Fatalf("错误文案 = %q，期望 %q", message, msgFileFieldMissing)
	}
}

// 非 multipart 请求体按请求格式错误拒绝。
func TestUploadRejectsNonMultipart(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)

	request := httptest.NewRequest(http.MethodPost, UploadPath, strings.NewReader(`{"file":"x"}`))
	request.Header.Set("Content-Type", "application/json")

	status, payload := upload(t, handler, request)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("状态码 = %d，期望 422：%v", status, payload)
	}
	if message, _ := errorOf(t, payload); message != msgMultipartOnly {
		t.Fatalf("错误文案 = %q，期望 %q", message, msgMultipartOnly)
	}
}

// 空文件按失败处理，避免落盘一个零字节图片。
func TestUploadRejectsEmptyFile(t *testing.T) {
	configDir := t.TempDir()
	handler := NewHandler(configDir)

	status, payload := upload(t, handler, multipartRequest(t, "empty.png", "image/png", nil))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("状态码 = %d，期望 422：%v", status, payload)
	}
	if message, _ := errorOf(t, payload); message != msgEmptyFile {
		t.Fatalf("错误文案 = %q，期望 %q", message, msgEmptyFile)
	}
}

// 非上传路径与非 POST 方法都回 JSON 404，不回退到 SPA。
func TestUploadRejectsOtherRoutes(t *testing.T) {
	handler := NewHandler(t.TempDir())

	cases := []*http.Request{
		httptest.NewRequest(http.MethodPost, "/api/assets/other", nil),
		httptest.NewRequest(http.MethodGet, UploadPath, nil),
	}
	for _, request := range cases {
		status, payload := upload(t, handler, request)
		if status != http.StatusNotFound {
			t.Fatalf("%s %s 状态码 = %d，期望 404", request.Method, request.URL.Path, status)
		}
		if message, code := errorOf(t, payload); code != "NOT_FOUND" || message != msgAPINotFound {
			t.Fatalf("%s %s 错误 = (%q, %q)，期望 NOT_FOUND", request.Method, request.URL.Path, message, code)
		}
	}
}

// 文件名清洗：取 basename、去扩展名、非法字符转 -、截断 48 字符、转小写，空名回落 image。
func TestSanitizeBase(t *testing.T) {
	cases := map[string]string{
		"My Photo.PNG":       "my-photo",
		"../../etc/passwd":   "passwd",
		`C:\tmp\bg-dark.JPG`: "bg-dark",
		"图 标.png":            "图-标",
		"":                   "image",
		"---.png":            "image",
		"a__b.c":             "a__b",
	}
	for input, expected := range cases {
		if got := sanitizeBase(input); got != expected {
			t.Errorf("sanitizeBase(%q) = %q，期望 %q", input, got, expected)
		}
	}

	long := sanitizeBase(strings.Repeat("x", 80) + ".png")
	if len([]rune(long)) != filenameMaxBase {
		t.Fatalf("超长名称应截断到 %d 个字符，实际 %q", filenameMaxBase, long)
	}
}

// 魔数校验：扩展名与内容必须成对，SVG 只看起始内容。
func TestMagicMatches(t *testing.T) {
	if !magicMatches(".png", testPNG()) {
		t.Fatalf("合法 PNG 应通过校验")
	}
	if magicMatches(".png", []byte("plain text")) {
		t.Fatalf("文本不得通过 PNG 校验")
	}
	if magicMatches(".gif", testPNG()) {
		t.Fatalf("PNG 内容不得通过 GIF 校验")
	}
	if !magicMatches(".svg", []byte("  \n<svg xmlns=\"http://www.w3.org/2000/svg\"/>")) {
		t.Fatalf("以 <svg 开头的内容应通过 SVG 校验")
	}
	if !magicMatches(".svg", []byte(`<?xml version="1.0"?><svg/>`)) {
		t.Fatalf("以 <?xml 开头的内容应通过 SVG 校验")
	}
	if magicMatches(".svg", []byte("<html></html>")) {
		t.Fatalf("HTML 内容不得通过 SVG 校验")
	}
}

// 读回请求体，供改写分段字段名使用。
func requestBody(t *testing.T, request *http.Request) string {
	t.Helper()

	buffer := &bytes.Buffer{}
	if _, err := buffer.ReadFrom(request.Body); err != nil {
		t.Fatalf("读取请求体失败：%v", err)
	}
	return buffer.String()
}
