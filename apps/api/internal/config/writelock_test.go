package config

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 写回进行中读路径被挡住：读锁不会在写锁持有期间进入，
// 因此不会读到五次替换之间的混版快照。
func TestWriteLockExcludesReaders(t *testing.T) {
	var (
		insideRead atomic.Int32
		writeHeld  atomic.Bool
	)
	writing := make(chan struct{})
	release := make(chan struct{})

	go func() {
		configWriteLock.lockWrite()
		writeHeld.Store(true)
		close(writing)
		<-release
		writeHeld.Store(false)
		configWriteLock.unlockWrite()
	}()

	<-writing

	done := make(chan struct{})
	go func() {
		defer close(done)
		configWriteLock.lockRead()
		defer configWriteLock.unlockRead()
		// 拿到读锁的瞬间写者必须已经离开
		if writeHeld.Load() {
			t.Error("读锁不应在写锁持有期间进入")
		}
		insideRead.Add(1)
	}()

	// 读请求必须被挡住，直到写锁释放
	select {
	case <-done:
		t.Fatal("写锁持有时读请求不应立即完成")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("写锁释放后读请求应继续")
	}
	if insideRead.Load() != 1 {
		t.Error("读请求应恰好执行一次")
	}
}

// 多个读者可并发，写者独占；并发写回不会互相穿插。
func TestConcurrentWritesSerialize(t *testing.T) {
	resetConfigGate(t)
	dir := writeConfigDir(t, map[string]string{
		FileSettings:  "title: 初值\nuseEqualHeights: false\n",
		FileServices:  "- Server:\n    - name: 保留\n      href: https://example.com/keep\n",
		FileBookmarks: testBookmarksYAML,
		FileWidgets:   testWidgetsYAML,
		FileDocker:    testDockerYAML,
	})

	titles := []string{"甲", "乙", "丙", "丁"}
	var waitGroup sync.WaitGroup
	errs := make([]error, len(titles))
	for index, title := range titles {
		waitGroup.Add(1)
		go func(index int, title string) {
			defer waitGroup.Done()
			payload := baseWritePayload()
			payload.Settings.Title = title
			_, errs[index] = WriteConfig(context.Background(), dir, payload)
		}(index, title)
	}
	waitGroup.Wait()

	for index, err := range errs {
		if err != nil {
			t.Errorf("第 %d 个写回失败：%v", index, err)
		}
	}

	// 最后一份配置必须是某一次完整写回的结果，不是多次写入的混合
	after := mustLoad(t, dir)
	matched := false
	for _, title := range titles {
		if after.Config.Settings.Title == title {
			matched = true
		}
	}
	if !matched {
		t.Errorf("最终标题应为某一次写回的值，实得 %q", after.Config.Settings.Title)
	}
}
