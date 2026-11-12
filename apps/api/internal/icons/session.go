package icons

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// 会话的容量与时限：短 TTL 且总量有限，进程重启即丢，不参与持久配置。
const (
	// DefaultSessionTTL 是 Resolve 到 Import 的有效窗口。
	DefaultSessionTTL = 5 * time.Minute
	// MaxSessions 是同时保留的会话上限，超出时淘汰最早的会话。
	MaxSessions = 200
)

// 会话内的一份候选字节与展示元数据。
type cachedCandidate struct {
	candidateID   string
	tier          Tier
	ext           ImageExt
	contentType   string
	body          []byte
	declaredSizes string
	declaredType  string
}

// 一次 Resolve 建立的状态，只在该进程内有效。
type session struct {
	sessionID string
	sourceURL string
	createdAt time.Time
	expiresAt time.Time
	// 候选按标识索引，键与 Resolve 返回的候选一一对应
	byID map[string]*cachedCandidate
}

// 保存未导入的候选字节；全部方法自行加锁，可被并发请求共用。
type sessionStore struct {
	mu          sync.Mutex
	sessions    map[string]*session
	ttl         time.Duration
	maxSessions int
	now         func() time.Time
}

// 新建会话仓库；ttl 或容量不合法时回落到固定默认值。
func newSessionStore(ttl time.Duration, maxSessions int) *sessionStore {
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	if maxSessions <= 0 {
		maxSessions = MaxSessions
	}
	return &sessionStore{
		sessions:    make(map[string]*session),
		ttl:         ttl,
		maxSessions: maxSessions,
		now:         time.Now,
	}
}

// 登记一批候选并返回会话；调用前需确认候选非空。
func (s *sessionStore) create(sourceURL string, candidates []*cachedCandidate) *session {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.purgeExpiredLocked(now)
	s.evictOldestLocked()

	current := &session{
		sessionID: newSessionID(),
		sourceURL: sourceURL,
		createdAt: now,
		expiresAt: now.Add(s.ttl),
		byID:      make(map[string]*cachedCandidate, len(candidates)),
	}
	for _, candidate := range candidates {
		current.byID[candidate.candidateID] = candidate
	}
	s.sessions[current.sessionID] = current
	return current
}

// 一次取候选的结果分类：成功、会话缺失或候选缺失。
type lookupResult int

const (
	// lookupOK 表示会话与候选都命中。
	lookupOK lookupResult = iota
	// lookupSessionMissing 表示会话不存在或已过期。
	lookupSessionMissing
	// lookupCandidateMissing 表示会话有效但候选不在其中。
	lookupCandidateMissing
)

// 一次加锁内取会话与候选，避免两次查找之间会话到期导致分类前后不一致。
func (s *sessionStore) lookup(sessionID, candidateID string) (*session, *cachedCandidate, lookupResult) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.purgeExpiredLocked(now)
	current, ok := s.sessions[sessionID]
	if !ok || !now.Before(current.expiresAt) {
		return nil, nil, lookupSessionMissing
	}
	candidate, ok := current.byID[candidateID]
	if !ok {
		return current, nil, lookupCandidateMissing
	}
	return current, candidate, lookupOK
}

// 当前保留的会话数，已过期的先清掉。
func (s *sessionStore) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.purgeExpiredLocked(s.now())
	return len(s.sessions)
}

// 删除已到期会话，过期判定与取值一致：now 不早于 expiresAt 即失效。
func (s *sessionStore) purgeExpiredLocked(now time.Time) {
	for id, current := range s.sessions {
		if !now.Before(current.expiresAt) {
			delete(s.sessions, id)
		}
	}
}

// 容量已满时反复淘汰创建最早的会话，直到留出空位。
func (s *sessionStore) evictOldestLocked() {
	for len(s.sessions) >= s.maxSessions {
		var oldestID string
		var oldestAt time.Time
		for id, current := range s.sessions {
			if oldestID == "" || current.createdAt.Before(oldestAt) {
				oldestID, oldestAt = id, current.createdAt
			}
		}
		if oldestID == "" {
			return
		}
		delete(s.sessions, oldestID)
	}
}

// 会话标识为 16 字节随机值的十六进制，不可预测也不重复使用。
func newSessionID() string { return randomHex(16) }

// 候选标识为 8 字节随机值的十六进制，仅在所属会话内有效。
func newCandidateID() string { return randomHex(8) }

// 生成随机十六进制串；随机源不可用时返回空串，由调用方按失败处理。
func randomHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return ""
	}
	return hex.EncodeToString(buffer)
}
