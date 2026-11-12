package config

import (
	"sync"
)

// 配置读写锁：读可并发、写独占、写优先。
// 读路径与写回共用这一把锁，避免五次替换之间读到新旧混版的快照。

// 进程内唯一的配置读写锁。
var configWriteLock = newConfigRWLock()

// 带写优先的读写锁。
// 新到的读请求会在有写者排队时先等待，写回不会因持续读流量被饿死。
type configRWLock struct {
	mu sync.Mutex
	// 当前持读锁的数量
	readers int
	// 是否有写者持有锁
	writing bool
	// 正在等待的写者数量
	writeWait int

	readCond  *sync.Cond
	writeCond *sync.Cond
}

func newConfigRWLock() *configRWLock {
	lock := &configRWLock{}
	lock.readCond = sync.NewCond(&lock.mu)
	lock.writeCond = sync.NewCond(&lock.mu)
	return lock
}

// 获取读锁：有写者执行或排队时等待。
func (l *configRWLock) lockRead() {
	l.mu.Lock()
	for l.writing || l.writeWait > 0 {
		l.readCond.Wait()
	}
	l.readers++
	l.mu.Unlock()
}

// 释放读锁；最后一个读者离开时唤醒写者。
func (l *configRWLock) unlockRead() {
	l.mu.Lock()
	l.readers--
	if l.readers == 0 {
		l.writeCond.Broadcast()
	}
	l.mu.Unlock()
}

// 获取写锁：独占，且优先于其后到达的读请求。
func (l *configRWLock) lockWrite() {
	l.mu.Lock()
	l.writeWait++
	for l.writing || l.readers > 0 {
		l.writeCond.Wait()
	}
	l.writeWait--
	l.writing = true
	l.mu.Unlock()
}

// 释放写锁并唤醒全部等待者。
func (l *configRWLock) unlockWrite() {
	l.mu.Lock()
	l.writing = false
	l.readCond.Broadcast()
	l.writeCond.Broadcast()
	l.mu.Unlock()
}

// 读路径执行：整次五文件解析都在读锁内，确保拿到同一版本。
func withConfigRead[T any](fn func() (T, error)) (T, error) {
	configWriteLock.lockRead()
	defer configWriteLock.unlockRead()
	return fn()
}
