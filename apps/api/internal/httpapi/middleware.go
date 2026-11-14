package httpapi

import (
	"log"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/klauspost/compress/gzhttp"
)

// 响应体不小于该字节数才压缩；更小的响应省下的字节抵不过压缩开销。
const gzipMinBytes = 512

// 流式端点按行推送，压缩会攒住缓冲破坏实时性，必须整类跳过。
var streamingContentTypes = []string{"application/x-ndjson", "text/event-stream"}

// 只有这类响应体压缩后仍可直接使用。
var compressibleContentTypes = []string{"application/json", "text/"}

// gzipWrapper 是配置好阈值的压缩包装器；参数全是常量，构造失败只会是
// 库版本行为变化，此时退化为直通，保住服务可用性。
var gzipWrapper = newGzipWrapper()

// newGzipWrapper 构造压缩中间件：客户端接受、类型可压缩且非流式、
// 响应体达到阈值才压缩。决策推迟到首个响应体写入，状态码与响应头不会提前定型。
func newGzipWrapper() func(http.Handler) http.Handler {
	wrapper, err := gzhttp.NewWrapper(
		gzhttp.MinSize(gzipMinBytes),
		// 保持既有线上行为：只协商 gzip，不引入 zstd
		gzhttp.EnableZstd(false),
		gzhttp.ContentTypeFilter(isCompressibleContentType),
	)
	if err != nil {
		log.Printf("压缩中间件构造失败，已退化为不压缩：%v", err)
		return func(next http.Handler) http.Handler { return next }
	}
	// gzhttp 包装器返回 HandlerFunc，按 Middleware 签名收敛
	return func(next http.Handler) http.Handler { return wrapper(next) }
}

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

// Gzip 按需压缩响应体；类型判定与阈值见 newGzipWrapper。
func Gzip(next http.Handler) http.Handler {
	return gzipWrapper(next)
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

// 请求日志固定写到标准输出；错误与堆栈留在标准错误，两类信息便于分流采集。
var requestLog = log.New(os.Stdout, "", log.LstdFlags)

// 是否压缩该类型：流式类型一律跳过，文本与 JSON 收益明确，其余类型不压。
func isCompressibleContentType(contentType string) bool {
	if isStreamingContentType(contentType) {
		return false
	}
	for _, compressible := range compressibleContentTypes {
		if strings.HasPrefix(contentType, compressible) {
			return true
		}
	}
	return false
}

// 流式类型：逐条推送，压缩会破坏时效。
func isStreamingContentType(contentType string) bool {
	for _, streaming := range streamingContentTypes {
		if strings.HasPrefix(contentType, streaming) {
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
