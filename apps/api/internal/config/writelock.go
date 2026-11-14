package config

import (
	"sync"
)

// 配置读写锁：读可并发、写独占、写优先。
// 读路径与写回共用这一把锁，避免五次替换之间读到新旧混版的快照。

// 进程内唯一的配置读写锁。
var configWriteLock = newConfigRWLock()

// configRWLock 是 sync.RWMutex 的薄封装：写回不会被持续读流量饿死，
// 因为 sync.RWMutex 自 Go 1.9 起即为写优先——被阻塞的写锁会拦住新读者。
type configRWLock struct {
	rw sync.RWMutex
}

func newConfigRWLock() *configRWLock { return &configRWLock{} }

// 获取读锁：有写者执行或排队时等待。
func (l *configRWLock) lockRead() { l.rw.RLock() }

// 释放读锁。
func (l *configRWLock) unlockRead() { l.rw.RUnlock() }

// 获取写锁：独占，且优先于其后到达的读请求。
func (l *configRWLock) lockWrite() { l.rw.Lock() }

// 释放写锁并唤醒等待者。
func (l *configRWLock) unlockWrite() { l.rw.Unlock() }

// 读路径执行：整次五文件解析都在读锁内，确保拿到同一版本。
func withConfigRead[T any](fn func() (T, error)) (T, error) {
	configWriteLock.lockRead()
	defer configWriteLock.unlockRead()
	return fn()
}
