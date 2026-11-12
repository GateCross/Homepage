package icons

import (
	"path/filepath"
	"testing"
	"time"
)

// 会话在 TTL 内可反复取值，过期后一律取不到，且不留残余。
func TestSessionStoreExpiresAfterTTL(t *testing.T) {
	store := newSessionStore(50*time.Millisecond, 10)
	current := store.create("https://example.com", []*cachedCandidate{
		{candidateID: "cand-a", tier: TierRelIcon, ext: ExtPNG, body: testPNG("a")},
	})
	if current.sessionID == "" {
		t.Fatal("会话标识不得为空")
	}

	found, candidate, status := store.lookup(current.sessionID, "cand-a")
	if status != lookupOK || found.sourceURL != "https://example.com" || len(candidate.body) == 0 {
		t.Fatalf("新会话应可取出候选，实得 status=%d session=%+v", status, found)
	}
	if _, _, status := store.lookup(current.sessionID, "cand-missing"); status != lookupCandidateMissing {
		t.Fatalf("未知候选应归类为候选缺失，实得 status=%d", status)
	}

	time.Sleep(80 * time.Millisecond)

	if _, _, status := store.lookup(current.sessionID, "cand-a"); status != lookupSessionMissing {
		t.Fatalf("过期会话应归类为会话缺失，实得 status=%d", status)
	}
	if store.size() != 0 {
		t.Fatalf("过期会话应被清理，剩余 %d 个", store.size())
	}
}

// 容量达到上限时淘汰创建最早的会话，保持会话总数不超限。
func TestSessionStoreEvictsOldest(t *testing.T) {
	store := newSessionStore(time.Minute, 2)
	first := store.create("https://a.example.com", []*cachedCandidate{{candidateID: "a"}})
	time.Sleep(2 * time.Millisecond)
	second := store.create("https://b.example.com", []*cachedCandidate{{candidateID: "b"}})
	time.Sleep(2 * time.Millisecond)
	third := store.create("https://c.example.com", []*cachedCandidate{{candidateID: "c"}})

	if store.size() != 2 {
		t.Fatalf("会话数 = %d，期望 2", store.size())
	}
	if _, _, status := store.lookup(first.sessionID, "a"); status != lookupSessionMissing {
		t.Fatal("最早的会话应被淘汰")
	}
	if _, _, status := store.lookup(second.sessionID, "b"); status != lookupOK {
		t.Fatal("较新的会话应保留")
	}
	if _, _, status := store.lookup(third.sessionID, "c"); status != lookupOK {
		t.Fatal("最新会话应保留")
	}
}

// 两个随机标识都必须非空且互不相同。
func TestRandomIdentifiers(t *testing.T) {
	sessionA, sessionB := newSessionID(), newSessionID()
	if sessionA == "" || sessionA == sessionB {
		t.Fatalf("会话标识应非空且互不相同：%q %q", sessionA, sessionB)
	}
	if len(sessionA) != 32 {
		t.Fatalf("会话标识长度 = %d，期望 32 位十六进制", len(sessionA))
	}
	if len(newCandidateID()) != 16 {
		t.Fatalf("候选标识长度 = %d，期望 16 位十六进制", len(newCandidateID()))
	}
}

// 落点必须在 images 目录内：上级目录与同前缀的兄弟目录都不算命中。
func TestWithinDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "images")

	if !withinDir(dir, filepath.Join(dir, "icon-1-abc.png")) {
		t.Fatal("images 目录下的文件应通过校验")
	}
	if withinDir(dir, filepath.Join(dir, "..", "settings.yaml")) {
		t.Fatal("上级目录文件不得通过校验")
	}
	if withinDir(dir, filepath.Join(dir+"-other", "icon.png")) {
		t.Fatal("同前缀的兄弟目录不得通过校验")
	}
}
