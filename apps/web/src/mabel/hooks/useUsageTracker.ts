import { useCallback, useEffect, useState } from "react";

export type UsageKind = "skill" | "connector" | "pack";

export type UsageMap = Record<string, number[]>;

export type UsageState = Record<UsageKind, UsageMap>;

const STORAGE_KEY = "mabel-usage-tracker";
const MAX_PER_ITEM = 12;

function emptyState(): UsageState {
  return { skill: {}, connector: {}, pack: {} };
}

function loadFromStorage(): UsageState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<UsageState>;
    return {
      skill: parsed.skill || {},
      connector: parsed.connector || {},
      pack: parsed.pack || {},
    };
  } catch {
    return emptyState();
  }
}

function saveToStorage(state: UsageState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

/** localStorage-backed tracker of "which conversations used which item". */
export function useUsageTracker() {
  const [usage, setUsage] = useState<UsageState>(() => loadFromStorage());

  useEffect(() => {
    saveToStorage(usage);
  }, [usage]);

  const record = useCallback(
    (kind: UsageKind, itemId: string, conversationId: number) => {
      if (!itemId || !Number.isFinite(conversationId)) return;
      setUsage((prev) => {
        const bucket = { ...(prev[kind] || {}) };
        const existing = bucket[itemId] || [];
        if (existing[0] === conversationId) return prev;
        bucket[itemId] = [conversationId, ...existing.filter((cid) => cid !== conversationId)].slice(0, MAX_PER_ITEM);
        return { ...prev, [kind]: bucket };
      });
    },
    [],
  );

  const clearItem = useCallback((kind: UsageKind, itemId: string) => {
    setUsage((prev) => {
      const bucket = { ...(prev[kind] || {}) };
      delete bucket[itemId];
      return { ...prev, [kind]: bucket };
    });
  }, []);

  const pruneMissingConversations = useCallback((knownIds: Set<number>) => {
    setUsage((prev) => {
      let changed = false;
      const next = { ...prev };
      (Object.keys(next) as UsageKind[]).forEach((kind) => {
        const bucket = next[kind] || {};
        const cleaned: UsageMap = {};
        Object.entries(bucket).forEach(([itemId, ids]) => {
          const filtered = ids.filter((cid) => knownIds.has(cid));
          if (filtered.length !== ids.length) changed = true;
          if (filtered.length > 0) cleaned[itemId] = filtered;
        });
        next[kind] = cleaned;
      });
      return changed ? next : prev;
    });
  }, []);

  return { usage, record, clearItem, pruneMissingConversations };
}
