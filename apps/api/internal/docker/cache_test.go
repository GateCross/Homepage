package docker

import (
	"testing"
	"time"

	"github.com/gatecross/homepage/api/internal/domain"
)

// 可控时钟：测试按需推进，验证 TTL 边界。
type fakeClock struct {
	now time.Time
}

// 当前时间。
func (c *fakeClock) Now() time.Time { return c.now }

// 推进时间。
func (c *fakeClock) Advance(duration time.Duration) { c.now = c.now.Add(duration) }

// 运行中样本。
func runningValue() domain.DockerStatusResponse {
	return domain.DockerStatusResponse{Status: domain.DockerStatusRunning}
}

func TestCacheThreeStates(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	cache := NewCacheWithTTL(FreshTTL, StaleTTL, clock.Now)

	cache.Set("local", "web", BucketFull, runningValue())

	if hit := cache.Lookup("local", "web", BucketFull); hit.Kind != HitFresh {
		t.Fatalf("刚写入应为 fresh，实得 %v", hit.Kind)
	}

	// 新鲜窗口边界：恰好 12s 已过期，进入 stale
	clock.Advance(FreshTTL)
	if hit := cache.Lookup("local", "web", BucketFull); hit.Kind != HitStale {
		t.Fatalf("12s 整应转 stale，实得 %v", hit.Kind)
	}
	if hit := cache.Lookup("local", "web", BucketFull); hit.Value.Status != domain.DockerStatusRunning {
		t.Fatalf("stale 仍需带回旧值，实得 %q", hit.Value.Status)
	}

	// 陈旧窗口边界：45s 后彻底未命中
	clock.Advance(StaleTTL - FreshTTL)
	if hit := cache.Lookup("local", "web", BucketFull); hit.Kind != HitMiss {
		t.Fatalf("45s 整应为 miss，实得 %v", hit.Kind)
	}
}

func TestCacheMissAndBucketsAreSeparate(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	cache := NewCacheWithTTL(FreshTTL, StaleTTL, clock.Now)

	if hit := cache.Lookup("local", "web", BucketFull); hit.Kind != HitMiss {
		t.Fatalf("未写入应为 miss，实得 %v", hit.Kind)
	}

	cache.Set("local", "web", BucketLite, runningValue())
	if hit := cache.Lookup("local", "web", BucketFull); hit.Kind != HitMiss {
		t.Fatal("lite 结果不得污染 full 分桶")
	}
	if hit := cache.Lookup("local", "web", BucketLite); hit.Kind != HitFresh {
		t.Fatal("lite 分桶应命中")
	}
}

func TestCacheSetRenewsLifetime(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	cache := NewCacheWithTTL(FreshTTL, StaleTTL, clock.Now)

	cache.Set("local", "web", BucketLite, runningValue())
	clock.Advance(FreshTTL - time.Second)
	cache.Set("local", "web", BucketLite, runningValue())

	// 续期后从第二次写入起重新计时
	clock.Advance(FreshTTL - time.Second)
	if hit := cache.Lookup("local", "web", BucketLite); hit.Kind != HitFresh {
		t.Fatalf("续期后仍在新鲜窗口，实得 %v", hit.Kind)
	}
}
