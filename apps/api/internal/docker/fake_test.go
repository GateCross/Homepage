package docker

import (
	"context"
	"strconv"
	"strings"
	"sync"

	"github.com/gatecross/homepage/api/internal/config"
)

// fakeTransport 记录每次请求路径，并由测试决定返回值或阻塞时机。
type fakeTransport struct {
	mu       sync.Mutex
	requests []string
	handler  func(ctx context.Context, path string) (Response, error)
}

// 执行一次请求并记录路径；handler 为空时返回空对象。
func (f *fakeTransport) Do(ctx context.Context, _ config.DockerEndpoint, req Request) (Response, error) {
	f.mu.Lock()
	f.requests = append(f.requests, req.Path)
	handler := f.handler
	f.mu.Unlock()

	if handler == nil {
		return Response{StatusCode: 200, Body: []byte("{}")}, nil
	}
	return handler(ctx, req.Path)
}

// 请求总数。
func (f *fakeTransport) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

// 命中指定路径前缀的请求数。
func (f *fakeTransport) countPrefix(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	total := 0
	for _, path := range f.requests {
		if strings.HasPrefix(path, prefix) {
			total++
		}
	}
	return total
}

// 按顺序返回已记录的路径。
func (f *fakeTransport) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.requests))
	copy(out, f.requests)
	return out
}

// 构造容器详情报文。
func inspectBody(statusText string, running bool, pid int) []byte {
	return []byte(`{"State":{"Status":"` + statusText + `","Running":` +
		strconv.FormatBool(running) + `,"Pid":` + strconv.Itoa(pid) + `}}`)
}

// 构造一次性 stats 报文；precpu 与当前相同，单独验证进程内差分不会误用。
func statsBody(totalUsage, systemUsage, usage, limit float64) []byte {
	number := func(value float64) string {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return []byte(`{"cpu_stats":{"cpu_usage":{"total_usage":` + number(totalUsage) +
		`,"percpu_usage":[1,2]},"system_cpu_usage":` + number(systemUsage) +
		`,"online_cpus":2},` +
		`"precpu_stats":{"cpu_usage":{"total_usage":` + number(totalUsage) +
		`},"system_cpu_usage":` + number(systemUsage) + `},` +
		`"memory_stats":{"usage":` + number(usage) +
		`,"limit":` + number(limit) + `,"stats":{"inactive_file":0}}}`)
}
