package docker

import (
	"sync"
	"time"

	"github.com/gatecross/homepage/api/internal/domain"
)

// 缓存窗口：新鲜期内直接返回，过期后在陈旧窗口内先返回旧值并后台刷新。
const (
	// FreshTTL 与前端 15s 轮询对齐，略短于轮询以免永远陈旧。
	FreshTTL = 12 * time.Second
	// StaleTTL 是仍可服务旧值的窗口，超出即视为未命中。
	StaleTTL = 45 * time.Second
)

// Bucket 区分缓存分桶：lite 仅状态，full 含资源占用，分桶避免轻量结果污染指标。
type Bucket string

// 缓存分桶取值。
const (
	BucketLite Bucket = "lite"
	BucketFull Bucket = "full"
)

// HitKind 是查询结果的三态。
type HitKind int

// 三态取值：新鲜、陈旧可服务、未命中。
const (
	HitFresh HitKind = iota
	HitStale
	HitMiss
)

// Hit 是一次缓存查询结果；仅新鲜与陈旧两态带值。
type Hit struct {
	Kind  HitKind
	Value domain.DockerStatusResponse
}

// CacheEntry 记录新鲜与陈旧截止时间。
type CacheEntry struct {
	FreshUntil time.Time
	StaleUntil time.Time
	Value      domain.DockerStatusResponse
}

// Cache 是进程内状态缓存；零值不可用，须经构造函数创建。
type Cache struct {
	mu      sync.Mutex
	entries map[string]CacheEntry
	fresh   time.Duration
	stale   time.Duration
	now     func() time.Time
}

// NewCache 用默认窗口创建缓存。
func NewCache() *Cache {
	return NewCacheWithTTL(FreshTTL, StaleTTL, time.Now)
}

// NewCacheWithTTL 用指定窗口与时钟创建缓存；ttl 必须为正，stale 不小于 ttl。
func NewCacheWithTTL(ttl, stale time.Duration, now func() time.Time) *Cache {
	if now == nil {
		now = time.Now
	}
	if ttl <= 0 {
		ttl = FreshTTL
	}
	if stale < ttl {
		stale = ttl
	}
	return &Cache{entries: make(map[string]CacheEntry), fresh: ttl, stale: stale, now: now}
}

// 缓存键由分桶、服务名与容器名组成。
func cacheKey(server, container string, bucket Bucket) string {
	return string(bucket) + "\x00" + server + "\x00" + container
}

// Lookup 返回三态；超出陈旧窗口的条目当场删除。
func (c *Cache) Lookup(server, container string, bucket Bucket) Hit {
	key := cacheKey(server, container, bucket)

	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return Hit{Kind: HitMiss}
	}
	now := c.now()
	if now.Before(entry.FreshUntil) {
		return Hit{Kind: HitFresh, Value: entry.Value}
	}
	if now.Before(entry.StaleUntil) {
		return Hit{Kind: HitStale, Value: entry.Value}
	}
	delete(c.entries, key)
	return Hit{Kind: HitMiss}
}

// Set 写入结果并按当前时间续期；顺带清理已彻底过期的其它条目。
func (c *Cache) Set(server, container string, bucket Bucket, value domain.DockerStatusResponse) {
	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()
	for key, entry := range c.entries {
		if !now.Before(entry.StaleUntil) {
			delete(c.entries, key)
		}
	}
	c.entries[cacheKey(server, container, bucket)] = CacheEntry{
		FreshUntil: now.Add(c.fresh),
		StaleUntil: now.Add(c.stale),
		Value:      value,
	}
}

// Clear 丢弃全部条目。
func (c *Cache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]CacheEntry)
}
