/** 站点图标取图会话：短 TTL 内存缓存，供 Resolve → Import。 */
import { randomBytes } from "node:crypto";

import type { ImageExt, SiteIconTier } from "@homepage/domain";

export type CachedIconCandidate = {
  candidateId: string;
  tier: SiteIconTier;
  ext: ImageExt;
  contentType: string;
  bytes: Uint8Array;
  declaredSizes?: string;
  declaredType?: string;
};

export type IconFetchSession = {
  sessionId: string;
  sourceUrl: string;
  createdAt: number;
  expiresAt: number;
  candidates: Map<string, CachedIconCandidate>;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 200;

export type IconSessionStore = {
  create(
    sourceUrl: string,
    candidates: CachedIconCandidate[],
    ttlMs?: number,
  ): IconFetchSession;
  get(sessionId: string): IconFetchSession | null;
  takeCandidate(
    sessionId: string,
    candidateId: string,
  ): CachedIconCandidate | null;
  size(): number;
};

export function createIconSessionStore(
  options: { ttlMs?: number; maxSessions?: number; now?: () => number } = {},
): IconSessionStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const nowFn = options.now ?? (() => Date.now());
  const sessions = new Map<string, IconFetchSession>();

  function purgeExpired(now: number): void {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(id);
      }
    }
  }

  function evictOldestIfNeeded(): void {
    while (sessions.size >= maxSessions) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, s] of sessions) {
        if (s.createdAt < oldestAt) {
          oldestAt = s.createdAt;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      sessions.delete(oldestId);
    }
  }

  return {
    create(sourceUrl, candidates, overrideTtl) {
      const now = nowFn();
      purgeExpired(now);
      evictOldestIfNeeded();
      const sessionId = randomBytes(16).toString("hex");
      const map = new Map<string, CachedIconCandidate>();
      for (const c of candidates) {
        map.set(c.candidateId, c);
      }
      const session: IconFetchSession = {
        sessionId,
        sourceUrl,
        createdAt: now,
        expiresAt: now + (overrideTtl ?? ttlMs),
        candidates: map,
      };
      sessions.set(sessionId, session);
      return session;
    },

    get(sessionId) {
      const now = nowFn();
      purgeExpired(now);
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (session.expiresAt <= now) {
        sessions.delete(sessionId);
        return null;
      }
      return session;
    },

    takeCandidate(sessionId, candidateId) {
      const session = this.get(sessionId);
      if (!session) return null;
      const candidate = session.candidates.get(candidateId);
      if (!candidate) return null;
      return candidate;
    },

    size() {
      purgeExpired(nowFn());
      return sessions.size;
    },
  };
}

export function newCandidateId(): string {
  return randomBytes(8).toString("hex");
}
