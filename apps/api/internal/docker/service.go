package docker

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gatecross/homepage/api/internal/config"
	"github.com/gatecross/homepage/api/internal/domain"
)

// DefaultConcurrency 是单次批量的最大并行数；stats 采样慢，适当提高。
const DefaultConcurrency = 12

// Target 是一个已授权容器及其所属端点。
type Target struct {
	Server    string
	Container string
	Endpoint  config.DockerEndpoint
}

// Item 是流式批量中的单条结果。
// 类型别名而非另立结构，保证流式行与一次性数组共用同一份契约定义。
type Item = domain.DockerBatchItem

// BatchResponse 是一次性返回全部结果的响应体。
type BatchResponse = domain.DockerBatchStatusResponse

// Options 覆盖默认的缓存、并发、超时与传输层，便于测试注入。
type Options struct {
	Cache        *Cache
	Concurrency  int
	Timeout      time.Duration
	Transport    Transport
	Samples      *CpuSampleStore
	SeedGap      time.Duration
	Now          func() time.Time
	IncludeStats bool
}

// Service 按目标集合下发状态；缓存、去重与连接只创建一次，随副本共享。
type Service struct {
	targets      []Target
	cache        *Cache
	concurrency  int
	includeStats bool
	rt           *runtime
}

// runtime 保存跨请求复用的依赖。
type runtime struct {
	timeout   time.Duration
	transport Transport
	samples   *CpuSampleStore
	seedGap   time.Duration
	now       func() time.Time
	inflight  *inflightGroup
	refresh   chan struct{}
}

// NewService 用目标集合与选项创建服务；零值选项落到进程默认实现。
func NewService(targets []Target, opts Options) *Service {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	concurrency := opts.Concurrency
	if concurrency < 1 {
		concurrency = DefaultConcurrency
	}
	service := &Service{
		targets:      targets,
		cache:        opts.Cache,
		concurrency:  concurrency,
		includeStats: opts.IncludeStats,
	}
	if service.cache == nil {
		service.cache = defaultCache
	}

	service.rt = &runtime{
		timeout:   timeout,
		transport: opts.Transport,
		samples:   opts.Samples,
		seedGap:   opts.SeedGap,
		now:       opts.Now,
		inflight:  newInflightGroup(),
		refresh:   make(chan struct{}, concurrency),
	}
	if service.rt.transport == nil {
		service.rt.transport = NewHTTPTransport()
	}
	if service.rt.samples == nil {
		service.rt.samples = defaultCpuSamples
	}
	if service.rt.seedGap <= 0 {
		service.rt.seedGap = CpuSeedGap
	}
	if service.rt.now == nil {
		service.rt.now = time.Now
	}
	return service
}

// withTargets 派生目标集合与是否拉取资源占用不同的副本；缓存、去重与连接仍共享。
func (s *Service) withTargets(targets []Target, includeStats bool) *Service {
	clone := *s
	clone.targets = targets
	clone.includeStats = includeStats
	return &clone
}

// ListTargets 从当次允许列表枚举已登记容器，顺序稳定；未声明的端点直接跳过。
func ListTargets(allowList *config.AllowList) []Target {
	if allowList == nil {
		return nil
	}
	out := make([]Target, 0, len(allowList.DockerContainers))
	for key := range allowList.DockerContainers {
		server, container, ok := splitContainerKey(key)
		if !ok {
			continue
		}
		endpoint, declared := allowList.DockerEndpoints[server]
		if !declared {
			continue
		}
		if config.DockerContainerKey(server, container) != key {
			continue
		}
		out = append(out, Target{Server: server, Container: container, Endpoint: endpoint})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Server != out[j].Server {
			return out[i].Server < out[j].Server
		}
		return out[i].Container < out[j].Container
	})
	return out
}

// 登记键固定为 server::container，两段都须非空。
func splitContainerKey(key string) (string, string, bool) {
	sep := strings.Index(key, "::")
	if sep <= 0 || sep+2 >= len(key) {
		return "", "", false
	}
	server, container := key[:sep], key[sep+2:]
	if server == "" || container == "" {
		return "", "", false
	}
	return server, container, true
}

// Stream 逐个送出结果，谁先就绪谁先出；ctx 取消后 worker 立即退出并关闭通道。
func (s *Service) Stream(ctx context.Context) <-chan Item {
	out := make(chan Item)
	go func() {
		defer close(out)

		sem := make(chan struct{}, s.concurrency)
		var wg sync.WaitGroup
		for _, target := range s.targets {
			wg.Add(1)
			go func(target Target) {
				defer wg.Done()
				select {
				case sem <- struct{}{}:
					defer func() { <-sem }()
				case <-ctx.Done():
					return
				}
				item, ok := s.Query(ctx, target)
				if !ok {
					return
				}
				select {
				case out <- item:
				case <-ctx.Done():
				}
			}(target)
		}
		wg.Wait()
	}()
	return out
}

// Collect 读完整个流并按目标顺序排列，供一次性 JSON 响应使用。
// 流式送出顺序取决于就绪先后，数组响应保持稳定顺序便于前端复用与测试。
func (s *Service) Collect(ctx context.Context) []Item {
	collected := make(map[string]Item, len(s.targets))
	for item := range s.Stream(ctx) {
		collected[config.DockerContainerKey(item.Server, item.Container)] = item
	}

	items := make([]Item, 0, len(collected))
	for _, target := range s.targets {
		if item, ok := collected[config.DockerContainerKey(target.Server, target.Container)]; ok {
			items = append(items, item)
		}
	}
	return items
}

// Query 查询单个目标；缓存新鲜直接返回，陈旧先返回旧值再后台刷新，未命中才实时查。
// 第二个返回值为 false 表示 ctx 已取消、结果不可用。
func (s *Service) Query(ctx context.Context, target Target) (Item, bool) {
	bucket := BucketLite
	if s.includeStats {
		bucket = BucketFull
	}

	hit := s.cache.Lookup(target.Server, target.Container, bucket)
	if hit.Kind != HitMiss {
		if hit.Kind == HitStale {
			s.refreshAsync(target)
		}
		return Item{Server: target.Server, Container: target.Container, Result: hit.Value}, true
	}

	// full 路径复用 lite 缓存，不额外 inspect
	var result domain.DockerStatusResponse
	if s.includeStats {
		result = s.queryFull(ctx, target)
	} else {
		result = s.queryLite(ctx, target)
	}
	if ctx.Err() != nil {
		return Item{}, false
	}
	return Item{Server: target.Server, Container: target.Container, Result: result}, true
}

// 仅状态查询：同桶并发去重后写回缓存。
// 写缓存必须在去重窗口内完成，否则后来者可能既错过缓存又错过进行中的查询。
func (s *Service) queryLite(ctx context.Context, target Target) domain.DockerStatusResponse {
	key := "lite\x00" + target.Server + "\x00" + target.Container
	result, _ := doInflight(s.rt.inflight, ctx, key, func(ctx context.Context) domain.DockerStatusResponse {
		// 成为 leader 时可能刚有同键查询写完缓存，先复查再决定是否打 Docker
		if hit := s.cache.Lookup(target.Server, target.Container, BucketLite); hit.Kind == HitFresh {
			return hit.Value
		}
		status, err := s.clientFor(target.Endpoint).Inspect(ctx, target.Container)
		if err != nil {
			status = queryFailed()
		}
		// 请求被取消时结果不代表容器真实状态，不得写入缓存
		if ctx.Err() == nil {
			s.cache.Set(target.Server, target.Container, BucketLite, status)
		}
		return status
	})
	return result
}

// 完整查询：命中新鲜 lite 时只补 stats；stats 失败降级为无指标 running 且不写缓存。
func (s *Service) queryFull(ctx context.Context, target Target) domain.DockerStatusResponse {
	key := "full\x00" + target.Server + "\x00" + target.Container
	lite := s.cache.Lookup(target.Server, target.Container, BucketLite)

	query, ok := doInflight(s.rt.inflight, ctx, key, func(ctx context.Context) fullQuery {
		// 成为 leader 时可能刚有同键查询写完缓存，先复查再决定是否打 Docker
		if hit := s.cache.Lookup(target.Server, target.Container, BucketFull); hit.Kind == HitFresh {
			return fullQuery{result: hit.Value, persist: false}
		}

		var resolved fullQuery
		// 仅新鲜 lite 可复用；stale 不可信，容器可能已停
		if lite.Kind == HitFresh {
			if lite.Value.Status != domain.DockerStatusRunning {
				resolved = fullQuery{result: lite.Value, persist: true}
			} else if stats, err := s.clientFor(target.Endpoint).Stats(ctx, target.Container); err != nil {
				resolved = fullQuery{result: lite.Value, persist: false}
			} else {
				resolved = fullQuery{result: mergeRunningWithStats(lite.Value, stats), persist: true}
			}
		} else {
			resolved = s.inspectWithStats(ctx, target)
		}
		// 被取消的查询不得把降级结果当成真实状态续期
		if ctx.Err() == nil {
			s.persistFull(target, resolved)
		}
		return resolved
	})
	if !ok {
		return queryFailed()
	}
	return query.result
}

// fullQuery 携带是否需要写缓存；降级结果不得续期。
type fullQuery struct {
	result  domain.DockerStatusResponse
	persist bool
}

// 实时 inspect，运行中再补 stats；stats 失败保留运行态但不写缓存。
func (s *Service) inspectWithStats(ctx context.Context, target Target) fullQuery {
	client := s.clientFor(target.Endpoint)
	status, err := client.Inspect(ctx, target.Container)
	if err != nil {
		return fullQuery{result: queryFailed(), persist: true}
	}
	if status.Status != domain.DockerStatusRunning {
		return fullQuery{result: status, persist: true}
	}
	stats, err := client.Stats(ctx, target.Container)
	if err != nil {
		return fullQuery{result: status, persist: false}
	}
	return fullQuery{result: mergeRunningWithStats(status, stats), persist: true}
}

// full 结果同时写入两桶，后续轻量查询可直接复用。
func (s *Service) persistFull(target Target, query fullQuery) {
	if !query.persist {
		return
	}
	s.cache.Set(target.Server, target.Container, BucketFull, query.result)
	s.cache.Set(target.Server, target.Container, BucketLite, query.result)
}

// 后台刷新陈旧结果；并发上限与批量一致，拿不到槽位就放弃本次刷新。
func (s *Service) refreshAsync(target Target) {
	go func() {
		select {
		case s.rt.refresh <- struct{}{}:
			defer func() { <-s.rt.refresh }()
		default:
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), s.rt.timeout*3)
		defer cancel()
		if s.includeStats {
			s.queryFull(ctx, target)
			return
		}
		s.queryLite(ctx, target)
	}()
}

// 按端点构造客户端；传输层、采样表与时序在副本间共享。
func (s *Service) clientFor(endpoint config.DockerEndpoint) *Client {
	return NewClient(endpoint, ClientOptions{
		Timeout:   s.rt.timeout,
		Transport: s.rt.transport,
		Samples:   s.rt.samples,
		SeedGap:   s.rt.seedGap,
		Now:       s.rt.now,
	})
}

// 查询失败的统一降级结果。
func queryFailed() domain.DockerStatusResponse {
	return unavailable("Docker 查询失败")
}

// inflightGroup 让同一分桶、服务与容器的并发查询只打一次 Docker。
type inflightGroup struct {
	mu    sync.Mutex
	calls map[string]*inflightCall
}

// inflightCall 是进行中的一次查询，跟随者等它结束后取同一结果。
type inflightCall struct {
	done  chan struct{}
	value any
}

// 创建空的去重表。
func newInflightGroup() *inflightGroup {
	return &inflightGroup{calls: make(map[string]*inflightCall)}
}

// 执行或加入一次去重查询；ctx 取消时跟随者不等待，直接返回 false。
func doInflight[T any](group *inflightGroup, ctx context.Context, key string, work func(context.Context) T) (T, bool) {
	group.mu.Lock()
	if call, ok := group.calls[key]; ok {
		group.mu.Unlock()
		select {
		case <-call.done:
			value, _ := call.value.(T)
			return value, true
		case <-ctx.Done():
			var zero T
			return zero, false
		}
	}
	call := &inflightCall{done: make(chan struct{})}
	group.calls[key] = call
	group.mu.Unlock()

	value := work(ctx)

	group.mu.Lock()
	delete(group.calls, key)
	call.value = value
	close(call.done)
	group.mu.Unlock()
	return value, true
}

// 进程默认缓存，供路由与未注入缓存的调用复用。
var defaultCache = NewCache()
