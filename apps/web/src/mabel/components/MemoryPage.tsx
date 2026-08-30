import { useMemo, useState } from "react";

import type { MabelMemoryItem } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

type MemoryPageProps = {
  memoryItems: MabelMemoryItem[];
  onDelete: (itemId: string) => Promise<void>;
  onUseInChat: (prompt: string) => void;
  onExport: () => Promise<void>;
};

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function MemoryPage({
  memoryItems,
  onDelete,
  onUseInChat,
  onExport,
}: MemoryPageProps) {
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MabelMemoryItem | null>(null);

  const sorted = useMemo(
    () =>
      [...memoryItems].sort(
        (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(b.confidence || 0) - Number(a.confidence || 0),
      ),
    [memoryItems],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((item) => {
      const haystack = [
        item.key,
        item.content,
        item.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [search, sorted]);

  const exportMemory = async () => {
    setError(null);
    setBusyId("export");
    try {
      await onExport();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const removeMemory = async () => {
    if (!confirmDelete) return;
    setError(null);
    setBusyId(`delete-${confirmDelete.id}`);
    try {
      await onDelete(confirmDelete.id);
      setConfirmDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mabel-page mabel-memory">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Memory</h1>
          <p>Persistent context for preferences, account facts, and task-specific knowledge.</p>
        </div>
        <div className="mabel-page__actions">
          <input
            className="mabel-page__search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search memory"
          />
          <button
            type="button"
            className="mabel-button mabel-button--ghost"
            disabled={busyId === "export"}
            onClick={() => void exportMemory()}
          >
            {busyId === "export" ? "Exporting…" : "Export JSON"}
          </button>
        </div>
      </header>

      <div className="mabel-page__body mabel-memory__body">
        <section className="mabel-card">
          <h2 className="mabel-card__title">Saved memory ({sorted.length})</h2>
          {error ? <div className="mabel-form__error">{error}</div> : null}
          {filtered.length === 0 ? (
            <p className="mabel-muted">
              {memoryItems.length === 0
                ? "No saved memory yet. Mabel will remember useful preferences and facts from chat when appropriate."
                : "No saved memory matches this search."}
            </p>
          ) : (
            <ul className="mabel-page__list">
              {filtered.map((item) => (
                <li key={item.id} className="mabel-page__row mabel-page__row--column">
                  <div className="mabel-page__row-top">
                    <div className="mabel-page__row-main">
                      <strong>{item.key}</strong>
                      <span className="mabel-page__row-description">{item.content}</span>
                      {item.tags.length > 0 ? (
                        <div className="mabel-page__chips mabel-page__chips--memory">
                          {item.tags.map((tag) => (
                            <span className="mabel-page__tag" key={`${item.id}-${tag}`}>{tag}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="mabel-page__row-side">
                      <span className="mabel-pill">{Math.round(item.confidence * 100)}%</span>
                      <span className="mabel-page__row-meta">used {formatRelative(item.last_used_at)}</span>
                    </div>
                    <div className="mabel-page__row-actions">
                      <button
                        type="button"
                        className="mabel-button"
                        onClick={() =>
                          onUseInChat(
                            `Use this memory as context:\n${item.key}: ${item.content}${item.tags.length ? `\nTags: ${item.tags.join(", ")}` : ""}`,
                          )
                        }
                      >
                        Use in chat
                      </button>
                      <button
                        type="button"
                        className="mabel-button mabel-button--ghost mabel-button--danger"
                        disabled={busyId === `delete-${item.id}`}
                        onClick={() => setConfirmDelete(item)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete memory"
        body={
          confirmDelete
            ? `Delete "${confirmDelete.key}" from saved memory? This cannot be undone.`
            : undefined
        }
        destructive
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void removeMemory()}
      />
    </div>
  );
}
