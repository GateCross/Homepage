package config

import (
	"context"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// reloadDebounce 是配置目录事件到重新加载之间的静默窗口，合并编辑器一次保存产生的多个事件。
const reloadDebounce = 200 * time.Millisecond

// Store 持有当前快照；读取加读锁，重新加载成功后原子替换。
// Snapshot 返回的指针不得被调用方修改。
type Store struct {
	mu  sync.RWMutex
	cur *Snapshot
}

// NewStore 创建空快照的 Store；未加载前 Snapshot 返回空配置而非 nil。
func NewStore() *Store {
	return &Store{cur: emptySnapshot()}
}

// emptySnapshot 构造全空配置，保证读取方无需判空。
func emptySnapshot() *Snapshot {
	return &Snapshot{
		AllowList: NewAllowList(),
		Raw:       map[string]any{},
		Config: ConfigJSON{
			Settings:    normalizeSettings(nil),
			Services:    []ServiceGroupJSON{},
			Bookmarks:   []BookmarkGroupJSON{},
			InfoWidgets: []WidgetJSON{},
		},
	}
}

// Load 一次性加载指定目录的配置；成功才替换当前快照，失败保留旧快照。
func (s *Store) Load(dir string) error {
	snapshot, err := Load(dir)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.cur = snapshot
	s.mu.Unlock()
	return nil
}

// Snapshot 返回当前快照指针，读锁保护；调用方不得修改其内容。
func (s *Store) Snapshot() *Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur
}

// Replace 直接换成已加载好的快照，供写回成功后立即生效。
// snapshot 为 nil 时保持当前快照不变。
func (s *Store) Replace(snapshot *Snapshot) {
	if snapshot == nil {
		return
	}
	s.mu.Lock()
	s.cur = snapshot
	s.mu.Unlock()
}

// Watch 监听配置目录，变更后去抖重新加载；加载失败保留旧快照并输出中文错误。
// ctx 取消或监听通道关闭后返回，返回前不再触发重新加载。
func (s *Store) Watch(ctx context.Context, dir string) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer func() { _ = watcher.Close() }()

	if err := watcher.Add(dir); err != nil {
		return err
	}

	var (
		debounce <-chan time.Time
		timer    *time.Timer
	)
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil

		case event, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			if !isConfigFileEvent(event.Name) {
				continue
			}
			if timer != nil {
				timer.Stop()
			}
			timer = time.NewTimer(reloadDebounce)
			debounce = timer.C

		case <-debounce:
			debounce = nil
			if err := s.Load(dir); err != nil {
				log.Printf("配置重新加载失败，已保留上一份快照：%v", err)
				continue
			}
			log.Printf("配置已重新加载：%s", dir)

		case watchErr, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			log.Printf("配置目录监听异常：%v", watchErr)
		}
	}
}

// 只响应五份配置文件的写入、创建、删除与改名；其它文件事件忽略。
func isConfigFileEvent(name string) bool {
	base := filepath.Base(name)
	for _, configName := range ConfigFileNames {
		if base == configName {
			return true
		}
	}
	return false
}
