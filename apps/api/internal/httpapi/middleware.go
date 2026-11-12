package httpapi

import (
	"compress/gzip"
	"log"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"
)

// 响应体不小于该字节数才压缩；更小的响应省下的字节抵不过压缩开销。
const gzipMinBytes = 512

// 流式端点按行推送，压缩会攒住缓冲破坏实时性，必须整类跳过。
var streamingContentTypes = []string{"application/x-ndjson", "text/event-stream"}

// 只有这类响应体压缩后仍可直接使用。
var compressibleContentTypes = []string{"application/json", "text/"}

// 请求日志固定写到标准输出；错误与堆栈留在标准错误，两类信息便于分流采集。
var requestLog = log.New(os.Stdout, "", log.LstdFlags)

// Middleware 是包装函数的统一签名。
type Middleware func(http.Handler) http.Handler

// Chain 自外向内按声明顺序包装：Chain(h, A, B) 的执行顺序为 A → B → h。
func Chain(handler http.Handler, middlewares ...Middleware) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		if middlewares[i] != nil {
			handler = middlewares[i](handler)
		}
	}
	return handler
}

// Gzip 按需压缩响应体，四个条件同时满足才启用：
// 客户端声明支持 gzip、状态码 200、类型可压缩且非流式、响应体不小于 512 字节。
// 压缩决策推迟到首个响应体写入或处理结束，因此状态码与响应头都不会提前定型。
func Gzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writer := newGzipWriter(w, acceptsGzip(r.Header.Get("Accept-Encoding")))
		defer writer.close()
		next.ServeHTTP(writer, r)
	})
}

// LogRequests 输出方法、路径、状态码与耗时毫秒数。
func LogRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		requestLog.Printf("请求 %s %s 状态 %d 耗时 %d 毫秒",
			r.Method, r.URL.Path, recorder.statusOrOK(), time.Since(start).Milliseconds())
	})
}

// RecoverPanics 捕获处理链上的 panic，返回 500 信封；堆栈只进日志不进响应。
// 自己先接管 writer 才能判断响应是否已经开始，已开始就不再补写信封，
// 避免客户端收到半截响应后又拼上新的状态行。
func RecoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder := &statusRecorder{ResponseWriter: w}
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			// 标准库约定的静默中止，保持原语义继续上抛
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}
			log.Printf("请求处理发生 panic：%s %s：%v\n%s",
				r.Method, r.URL.Path, recovered, debug.Stack())
			if recorder.written {
				return
			}
			Internal("服务暂时不可用，请稍后重试").Write(recorder)
		}()
		next.ServeHTTP(recorder, r)
	})
}

// 客户端是否声明接受 gzip；q=0 属于明确拒绝。
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, parameter := range fields[1:] {
			key, value, found := strings.Cut(parameter, "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
				continue
			}
			switch strings.TrimSpace(value) {
			case "0", "0.0", "0.00", "0.000":
				return false
			}
		}
		return true
	}
	return false
}

// 流式类型：逐条推送，压缩会破坏时效。
func isStreamingType(contentType string) bool {
	for _, streaming := range streamingContentTypes {
		if strings.HasPrefix(contentType, streaming) {
			return true
		}
	}
	return false
}

// 可压缩类型：文本与 JSON 收益明确，二进制格式压缩后通常更大。
func isCompressibleType(contentType string) bool {
	for _, compressible := range compressibleContentTypes {
		if strings.HasPrefix(contentType, compressible) {
			return true
		}
	}
	return false
}

// statusRecorder 记录最终写出的状态码，并保证响应头只透传一次。
type statusRecorder struct {
	http.ResponseWriter
	status  int
	written bool
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.written {
		return
	}
	r.written = true
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(payload []byte) (int, error) {
	if !r.written {
		r.written = true
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(payload)
}

// 未显式写出状态码时标准库按 200 返回。
func (r *statusRecorder) statusOrOK() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

// Flush 透传，保证流式内容不被缓冲卡住。
func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap 让 http.ResponseController 能取到底层 writer。
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// gzipWriter 在首次写入前缓冲响应体，据此决定压缩与否。
// 状态码与响应头延迟到决策时刻提交，避免默认 200 提前定型。
type gzipWriter struct {
	http.ResponseWriter
	// 客户端接受 gzip 才有压缩可能
	negotiated bool
	status     int
	// 处理方是否显式写过状态码
	wroteHeader bool
	// 已提交响应头后不再接受改动
	decided bool
	// 压缩流；非空表示已按压缩路径写出
	zipper *gzip.Writer
	// 判定前的暂存体
	pending []byte
}

func newGzipWriter(w http.ResponseWriter, negotiated bool) *gzipWriter {
	return &gzipWriter{ResponseWriter: w, negotiated: negotiated, status: http.StatusOK}
}

func (w *gzipWriter) WriteHeader(status int) {
	if w.decided {
		return
	}
	w.wroteHeader = true
	w.status = status
}

func (w *gzipWriter) Write(payload []byte) (int, error) {
	if w.decided {
		if w.zipper != nil {
			return w.zipper.Write(payload)
		}
		return w.ResponseWriter.Write(payload)
	}

	if !w.compressible() {
		w.commitPlain()
		return w.ResponseWriter.Write(payload)
	}

	w.pending = append(w.pending, payload...)
	if len(w.pending) >= gzipMinBytes {
		w.startGzip()
	}
	return len(payload), nil
}

// 是否仍可能压缩：客户端接受、状态码 200、类型可压缩且非流式。
func (w *gzipWriter) compressible() bool {
	if !w.negotiated || w.status != http.StatusOK {
		return false
	}
	contentType := w.Header().Get("Content-Type")
	if contentType == "" || isStreamingType(contentType) || !isCompressibleType(contentType) {
		return false
	}
	return true
}

// 结束处理：缓冲量达到阈值就压缩，否则原样写出。
// 处理方既没写状态码也没写响应体时（典型是 panic 中断）不提交任何响应头，
// 让外层恢复逻辑还能补写自己的信封。
func (w *gzipWriter) close() {
	if w.decided {
		if w.zipper != nil {
			_ = w.zipper.Close()
		}
		return
	}
	if !w.wroteHeader && len(w.pending) == 0 {
		return
	}
	if w.compressible() && len(w.pending) >= gzipMinBytes {
		w.startGzip()
	}
	if w.zipper != nil {
		_ = w.zipper.Close()
		return
	}
	w.commitPlain()
	if len(w.pending) > 0 {
		_, _ = w.ResponseWriter.Write(w.pending)
		w.pending = nil
	}
}

// 以压缩方式提交：先改响应头再定型，最后把暂存体灌入压缩流。
func (w *gzipWriter) startGzip() {
	header := w.Header()
	header.Set("Content-Encoding", "gzip")
	// 压缩后长度不再等于原长度，交给分块编码
	header.Del("Content-Length")
	addVary(header)
	w.ResponseWriter.WriteHeader(w.status)
	w.decided = true

	w.zipper = gzip.NewWriter(w.ResponseWriter)
	if len(w.pending) > 0 {
		_, _ = w.zipper.Write(w.pending)
		w.pending = nil
	}
}

// 以未压缩方式提交响应头。
func (w *gzipWriter) commitPlain() {
	if w.decided {
		return
	}
	addVary(w.Header())
	w.ResponseWriter.WriteHeader(w.status)
	w.decided = true
}

// 响应随 Accept-Encoding 变化，缓存必须分开存储；已声明过则不重复追加。
func addVary(header http.Header) {
	for _, value := range header.Values("Vary") {
		if strings.Contains(strings.ToLower(value), "accept-encoding") {
			return
		}
	}
	header.Add("Vary", "Accept-Encoding")
}

// Flush 先完成压缩决策再透传，流式响应因此不会被缓冲阻塞。
func (w *gzipWriter) Flush() {
	if !w.decided {
		if w.compressible() && len(w.pending) >= gzipMinBytes {
			w.startGzip()
		} else {
			w.commitPlain()
			if len(w.pending) > 0 {
				_, _ = w.ResponseWriter.Write(w.pending)
				w.pending = nil
			}
		}
	}
	if w.zipper != nil {
		_ = w.zipper.Flush()
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap 让 http.ResponseController 能取到底层 writer。
func (w *gzipWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
