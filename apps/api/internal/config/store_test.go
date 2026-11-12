package config

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStoreWatchReloadsAndKeepsOldOnError(t *testing.T) {
	dir := t.TempDir()
	dockerPath := filepath.Join(dir, FileDocker)
	if err := os.WriteFile(dockerPath, []byte("my-docker: unix:///var/run/docker.sock\n"), 0o600); err != nil {
		t.Fatalf("写入配置失败：%v", err)
	}

	store := NewStore()
	if err := store.Load(dir); err != nil {
		t.Fatalf("首次加载失败：%v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- store.Watch(ctx, dir) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("监听结束返回错误：%v", err)
		}
	}()

	// 监听注册完成前写入的事件会丢失，因此重复写入直到热加载生效
	if !rewriteUntil(dir, FileDocker, "other: tcp://10.0.0.9:2375\n", func() bool {
		_, ok := store.Snapshot().AllowList.DockerEndpoints["other"]
		return ok
	}) {
		t.Fatal("等待配置热加载超时")
	}

	// 非法变更：重新加载失败，旧快照保持不变
	if err := os.WriteFile(filepath.Join(dir, FileDocker), []byte("other: [坏掉的\n"), 0o600); err != nil {
		t.Fatalf("写入配置失败：%v", err)
	}
	time.Sleep(3 * reloadDebounce)
	if _, ok := store.Snapshot().AllowList.DockerEndpoints["other"]; !ok {
		t.Error("重新加载失败时必须保留旧快照")
	}
}

// 反复写入并检查条件，覆盖监听尚未就绪的窗口。
func rewriteUntil(dir, name, content string, done func() bool) bool {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			return false
		}
		time.Sleep(reloadDebounce)
		if done() {
			return true
		}
	}
	return false
}
