import { useCallback, useEffect, useMemo, useState } from "react";

import { deleteMabelArtifact, getMabelArtifacts } from "../api";
import { fetchMabelCached, getMabelCached, invalidateMabelCache, mabelCacheKey } from "../sessionCache";
import type { MabelDocument } from "../types";

type ArtifactsPageProps = {
  onCreateInChat: (prompt: string, intent?: undefined, hiddenInstructions?: string) => void;
  onOpenArtifact: (artifact: { language: string; value: string }) => void;
  onOpenConversation: (conversationId: number) => void;
  onCountChange?: (count: number) => void;
};

function artifactLanguage(kind: MabelDocument["kind"]): string {
  if (kind === "dashboard" || kind === "html") return "html";
  if (kind === "markdown") return "markdown";
  return "text";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function contentSnippet(content: string): string {
  return content
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function buildCreatePrompt(): string {
  return "Help me create a dashboard artifact.";
}

function buildCreateInstructions(): string {
  return "Help me create a dashboard artifact. Ask what data it should show and which MCPs or sources it needs, then generate a clean HTML dashboard with it using mabel_save_artifact.";
}

export function ArtifactsPage({ onCreateInChat, onOpenArtifact, onOpenConversation, onCountChange }: ArtifactsPageProps) {
  const [artifacts, setArtifacts] = useState<MabelDocument[]>(() => getMabelCached<MabelDocument[]>(mabelCacheKey("artifacts")) || []);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(() => !getMabelCached<MabelDocument[]>(mabelCacheKey("artifacts")));
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadArtifacts = useCallback(async (options: { force?: boolean } = {}) => {
    const cacheKey = mabelCacheKey("artifacts");
    if (!options.force && getMabelCached<MabelDocument[]>(cacheKey)) {
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError("");
    try {
      const rows = await fetchMabelCached(cacheKey, () => getMabelArtifacts(), { force: options.force });
      setArtifacts(rows);
      onCountChange?.(rows.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter((artifact) => {
      const haystack = `${artifact.title} ${artifact.kind} ${artifact.content}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [artifacts, search]);

  const handleDelete = async (artifact: MabelDocument) => {
    setDeletingId(artifact.id);
    setError("");
    try {
      await deleteMabelArtifact(artifact.id);
      invalidateMabelCache(mabelCacheKey("artifacts"));
      const nextRows = artifacts.filter((row) => row.id !== artifact.id);
      setArtifacts(nextRows);
      onCountChange?.(nextRows.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownload = (artifact: MabelDocument) => {
    try {
      const blob = new Blob([artifact.content], { type: "text/html;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${artifact.title}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setError("Download failed");
    }
  };

  return (
    <div className="mabel-page mabel-artifacts-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Artifacts</h1>
          <p>Saved dashboards, reports, and outputs generated through Mabel chat and MCP data.</p>
        </div>
        <div className="mabel-page__actions">
          <input
            className="mabel-page__search"
            placeholder="Search artifacts"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="button" className="mabel-button" onClick={() => onCreateInChat(buildCreatePrompt(), undefined, buildCreateInstructions())}>
            Create in chat
          </button>
        </div>
      </header>

      <div className="mabel-page__body">
        {error ? <p className="mabel-page__notice mabel-page__notice--error">{error}</p> : null}
        {loading ? (
          <div className="mabel-artifacts-empty-state"><span>Loading artifacts...</span></div>
        ) : filtered.length === 0 ? (
          <div className="mabel-artifacts-empty-state">
            <span className="mabel-artifacts-empty-state__icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 15h7" /><path d="M14 20h5" /></svg>
            </span>
            <strong>{artifacts.length === 0 ? "No artifacts yet" : "No artifacts match"}</strong>
            <span>{artifacts.length === 0 ? "Create one from chat and Mabel will save it here." : "Try a different search."}</span>
          </div>
        ) : (
          <section className="mabel-artifacts-grid" aria-label="Saved artifacts">
            {filtered.map((artifact) => (
              <article key={artifact.id} className="mabel-artifact-card">
                <button
                  type="button"
                  className="mabel-artifact-card__main"
                  onClick={() => onOpenArtifact({ language: artifactLanguage(artifact.kind), value: artifact.content })}
                >
                  <strong>{artifact.title}</strong>
                  <span>{contentSnippet(artifact.content) || "Saved Mabel artifact"}</span>
                </button>
                <div className="mabel-artifact-card__meta">
                  <span>{formatDate(artifact.updated_at)}</span>
                  <span>{new Blob([artifact.content]).size.toLocaleString()} B</span>
                </div>
                <div className="mabel-artifact-card__actions">
                  {artifact.conversation_id ? (
                    <button type="button" className="mabel-button mabel-button--ghost" onClick={() => onOpenConversation(artifact.conversation_id!)}>
                      Open chat
                    </button>
                  ) : null}
                  <button type="button" className="mabel-button mabel-button--ghost" onClick={() => handleDownload(artifact)}>
                    Download
                  </button>
                  <button
                    type="button"
                    className="mabel-button mabel-button--ghost mabel-button--danger"
                    disabled={deletingId === artifact.id}
                    onClick={() => handleDelete(artifact)}
                  >
                    {deletingId === artifact.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
