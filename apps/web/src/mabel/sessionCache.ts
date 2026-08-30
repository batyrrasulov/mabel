/** Short-lived in-memory cache for Mabel session navigation (avoids refetch on remount). */

type CacheEntry<T> = { data: T; at: number };

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function mabelCacheKey(...parts: (string | number | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(":");
}

export const MABEL_LOGS_DEFAULT_DAYS = 7;
export const MABEL_LOGS_PAGE_LIMIT = 200;

export function mabelLogsCacheKey(days = MABEL_LOGS_DEFAULT_DAYS): string {
  return mabelCacheKey("logs", days, MABEL_LOGS_PAGE_LIMIT);
}

export function mabelConversationCacheKey(conversationId: number): string {
  return mabelCacheKey("conversation", conversationId);
}

export function mabelSkillDetailCacheKey(skillId: string): string {
  return mabelCacheKey("skill", skillId);
}

export function mabelSkillMetaCacheKey(skillId: string): string {
  return mabelCacheKey("skill-meta", skillId);
}

export function getMabelCached<T>(key: string, maxAgeMs = CACHE_TTL_MS): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > maxAgeMs) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setMabelCached<T>(key: string, data: T): void {
  cache.set(key, { data, at: Date.now() });
}

export function invalidateMabelCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    inflight.clear();
    return;
  }
  for (const key of [...cache.keys(), ...inflight.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      inflight.delete(key);
    }
  }
}

/** Test-only helper to avoid cross-test cache bleed in vitest. */
export function resetMabelSessionCache(): void {
  invalidateMabelCache();
}

export async function fetchMabelCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<T> {
  const { force = false, maxAgeMs = CACHE_TTL_MS } = options;
  if (!force) {
    const cached = getMabelCached<T>(key, maxAgeMs);
    if (cached !== null) return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = fetcher()
    .then((data) => {
      setMabelCached(key, data);
      inflight.delete(key);
      return data;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, promise);
  return promise;
}
