import { useCallback, useEffect, useRef, useState } from "react";

import {
  createMabelProject,
  deleteMabelProject,
  getMabelProject,
  moveMabelConversationToProject,
  updateMabelProject,
  uploadMabelFiles,
} from "../api";
import { fetchMabelCached, getMabelCached, invalidateMabelCache, mabelCacheKey } from "../sessionCache";
import type {
  MabelProject,
  MabelProjectDetail,
  MabelUploadedFile,
} from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

type ProjectsPageProps = {
  projects: MabelProject[];
  onRefreshProjects: () => Promise<MabelProject[]>;
  onConversationsChange: () => Promise<void> | void;
  onOpenConversation: (conversationId: number) => void;
  onStartChat: (project: MabelProject) => void;
  onOpenFile: (file: MabelUploadedFile) => void;
};

const PROJECT_COLORS: MabelProject["color"][] = [
  "slate",
  "blue",
  "green",
  "amber",
  "rose",
  "violet",
];

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectsPage({
  projects,
  onRefreshProjects,
  onConversationsChange,
  onOpenConversation,
  onStartChat,
  onOpenFile,
}: ProjectsPageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MabelProjectDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createColor, setCreateColor] = useState<MabelProject["color"]>("slate");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [movingConversationId, setMovingConversationId] = useState<number | null>(null);
  const [settingsDraft, setSettingsDraft] = useState({
    name: "",
    description: "",
    instructions: "",
    color: "slate" as MabelProject["color"],
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const detailRequestIdRef = useRef(0);

  const loadDetail = useCallback(async (projectId: string, options: { force?: boolean } = {}) => {
    const cacheKey = mabelCacheKey("project", projectId);
    if (!options.force) {
      const cached = getMabelCached<MabelProjectDetail>(cacheKey);
      if (cached) {
        setDetail(cached);
        setSettingsDraft({
          name: cached.project.name,
          description: cached.project.description,
          instructions: cached.project.instructions,
          color: cached.project.color,
        });
        setLoadingDetail(false);
        return;
      }
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setLoadingDetail(true);
    setError("");
    try {
      const payload = await fetchMabelCached(cacheKey, () => getMabelProject(projectId), { force: options.force });
      if (requestId !== detailRequestIdRef.current) return;
      setDetail(payload);
      setSettingsDraft({
        name: payload.project.name,
        description: payload.project.description,
        instructions: payload.project.instructions,
        color: payload.project.color,
      });
    } catch (err) {
      if (requestId !== detailRequestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === detailRequestIdRef.current) setLoadingDetail(false);
    }
  }, []);

  const refreshProjectsList = useCallback(async () => {
    invalidateMabelCache(mabelCacheKey("projects"));
    return onRefreshProjects();
  }, [onRefreshProjects]);

  useEffect(() => {
    if (!selectedId) {
      detailRequestIdRef.current += 1;
      setDetail(null);
      return;
    }
    if (
      !projects.some((project) => project.id === selectedId)
      && detail?.project.id !== selectedId
    ) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    if (!projects.some((project) => project.id === selectedId)) return;
    void loadDetail(selectedId);
  }, [detail?.project.id, loadDetail, projects, selectedId]);

  useEffect(() => {
    if (!createOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen]);

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError("");
    try {
      const project = await createMabelProject({
        name,
        description: createDescription.trim(),
        color: createColor,
      });
      setDetail({ project, conversations: [], files: [] });
      setSettingsDraft({
        name: project.name,
        description: project.description,
        instructions: project.instructions,
        color: project.color,
      });
      setSelectedId(project.id);
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      setCreateColor("slate");
      await refreshProjectsList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!detail || !settingsDraft.name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const project = await updateMabelProject(detail.project.id, {
        name: settingsDraft.name.trim(),
        description: settingsDraft.description.trim(),
        instructions: settingsDraft.instructions.trim(),
        color: settingsDraft.color,
      });
      await refreshProjectsList();
      invalidateMabelCache(mabelCacheKey("project", project.id));
      await loadDetail(project.id, { force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleFiles = async (files: File[]) => {
    if (!detail || files.length === 0 || uploading || saving) return;
    setUploading(true);
    setError("");
    try {
      await uploadMabelFiles(files, { projectId: detail.project.id });
      invalidateMabelCache(mabelCacheKey("project", detail.project.id));
      await loadDetail(detail.project.id, { force: true });
      await refreshProjectsList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleMoveConversation = async (conversationId: number, projectId: string | null) => {
    if (movingConversationId !== null) return;
    setMovingConversationId(conversationId);
    setError("");
    try {
      await moveMabelConversationToProject(conversationId, projectId);
      await Promise.all([onConversationsChange(), refreshProjectsList()]);
      if (detail) {
        invalidateMabelCache(mabelCacheKey("project", detail.project.id));
        await loadDetail(detail.project.id, { force: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMovingConversationId(null);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    setError("");
    try {
      await deleteMabelProject(detail.project.id);
      invalidateMabelCache(mabelCacheKey("project", detail.project.id));
      await Promise.all([onConversationsChange(), refreshProjectsList()]);
      setDeleteOpen(false);
      setSelectedId(null);
      setDetail(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mabel-page mabel-projects-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Projects</h1>
          <p>Keep related chats, files, and instructions together in one focused workspace.</p>
        </div>
        <div className="mabel-page__actions">
          {selectedId ? (
            <button type="button" className="mabel-button mabel-button--ghost" onClick={() => setSelectedId(null)}>
              All projects
            </button>
          ) : null}
          {projects.length > 0 ? (
            <button type="button" className="mabel-button" onClick={() => setCreateOpen(true)}>
              Create project
            </button>
          ) : null}
        </div>
      </header>

      <div className="mabel-page__body">
        {error ? <p className="mabel-page__notice mabel-page__notice--error">{error}</p> : null}
        {!selectedId ? (
          projects.length === 0 ? (
            <div className="mabel-feature-empty">
              <button type="button" className="mabel-button" onClick={() => setCreateOpen(true)}>
                Create project
              </button>
            </div>
          ) : (
            <section className="mabel-project-grid" aria-label="Mabel projects">
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  className="mabel-project-card"
                  onClick={() => setSelectedId(project.id)}
                >
                  <span className={`mabel-project-mark mabel-project-mark--${project.color}`} aria-hidden="true">
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="mabel-project-card__copy">
                    <strong>{project.name}</strong>
                    <span>{project.description || "Focused Mabel workspace"}</span>
                  </span>
                  <span className="mabel-project-card__meta">
                    {project.conversation_count} chat{project.conversation_count === 1 ? "" : "s"} · {project.file_count} file{project.file_count === 1 ? "" : "s"} · {formatDate(project.updated_at)}
                  </span>
                </button>
              ))}
            </section>
          )
        ) : loadingDetail && !detail ? (
          <div className="mabel-feature-empty"><span>Loading project...</span></div>
        ) : detail ? (
          <div className="mabel-project-detail">
            <section className="mabel-project-hero">
              <div className={`mabel-project-mark mabel-project-mark--${detail.project.color}`} aria-hidden="true">
                {detail.project.name.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <h2>{detail.project.name}</h2>
                <p>{detail.project.description || "Focused Mabel workspace"}</p>
              </div>
            </section>

            <div className="mabel-project-detail__grid">
              <section className="mabel-card mabel-project-section">
                <div className="mabel-project-section__head">
                  <div>
                    <h3>Chats</h3>
                  </div>
                  <button
                    type="button"
                    className="mabel-button mabel-button--ghost"
                    onClick={() => onStartChat(detail.project)}
                  >
                    New chat
                  </button>
                </div>
                {detail.conversations.length === 0 ? (
                  <p className="mabel-muted">No chats in this project yet.</p>
                ) : (
                  <ul className="mabel-project-list">
                    {detail.conversations.map((conversation) => (
                      <li key={conversation.id}>
                        <button type="button" onClick={() => onOpenConversation(conversation.id)}>
                          <strong>{conversation.title}</strong>
                          <span>{conversation.message_count} messages · {formatDate(conversation.updated_at)}</span>
                        </button>
                        <button
                          type="button"
                          className="mabel-project-list__remove"
                          disabled={movingConversationId === conversation.id}
                          onClick={() => void handleMoveConversation(conversation.id, null)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="mabel-card mabel-project-section">
                <div className="mabel-project-section__head">
                  <div>
                    <h3>Files</h3>
                  </div>
                  <button
                    type="button"
                    className="mabel-button mabel-button--ghost"
                    disabled={uploading || saving}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? "Uploading..." : "Add files"}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      event.target.value = "";
                      void handleFiles(files);
                    }}
                  />
                </div>
                {detail.files.length === 0 ? (
                  <p className="mabel-muted">No project files yet.</p>
                ) : (
                  <ul className="mabel-project-list">
                    {detail.files.map((file) => (
                      <li key={file.id}>
                        <button type="button" onClick={() => onOpenFile(file)}>
                          <strong>{file.name}</strong>
                          <span>{formatSize(file.size_bytes)} · {formatDate(file.created_at)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section className="mabel-card mabel-project-settings">
              <div className="mabel-project-section__head">
                <div>
                  <h3>Settings</h3>
                </div>
              </div>
              <div className="mabel-project-settings__fields">
                <label>
                  <span>Name</span>
                  <input
                    value={settingsDraft.name}
                    onChange={(event) => setSettingsDraft((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Description</span>
                  <input
                    value={settingsDraft.description}
                    onChange={(event) => setSettingsDraft((current) => ({ ...current, description: event.target.value }))}
                  />
                </label>
                <label className="mabel-project-settings__instructions">
                  <span>Instructions</span>
                  <textarea
                    rows={5}
                    placeholder="How should Mabel respond in this project?"
                    value={settingsDraft.instructions}
                    onChange={(event) => setSettingsDraft((current) => ({ ...current, instructions: event.target.value }))}
                  />
                </label>
              </div>
              <div className="mabel-project-settings__actions">
                <button type="button" className="mabel-button mabel-button--ghost mabel-button--danger" onClick={() => setDeleteOpen(true)}>
                  Delete project
                </button>
                <button type="button" className="mabel-button" disabled={saving || !settingsDraft.name.trim()} onClick={() => void handleSave()}>
                  {saving ? "Saving..." : "Save settings"}
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </div>

      {createOpen ? (
        <div className="mabel-modal" role="dialog" aria-modal="true" aria-label="Create project">
          <div className="mabel-modal__backdrop" onClick={() => setCreateOpen(false)} aria-hidden="true" />
          <div className="mabel-modal__panel mabel-modal__panel--sm">
            <header className="mabel-modal__head"><h2>Create project</h2></header>
            <section className="mabel-modal__section mabel-project-create">
              <label>
                <span>Name</span>
                <input
                  autoFocus
                  aria-label="Name"
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleCreate();
                  }}
                />
              </label>
              <label>
                <span>Description (optional)</span>
                <textarea
                  rows={3}
                  value={createDescription}
                  onChange={(event) => setCreateDescription(event.target.value)}
                />
              </label>
              <fieldset>
                <legend>Color</legend>
                <div className="mabel-project-color-picker">
                  {PROJECT_COLORS.map((color) => (
                    <label key={color} title={color}>
                      <input
                        type="radio"
                        name="project-color"
                        value={color}
                        aria-label={`Project color ${color}`}
                        checked={createColor === color}
                        onChange={() => setCreateColor(color)}
                      />
                      <span className={`mabel-project-color mabel-project-mark--${color}`} />
                    </label>
                  ))}
                </div>
              </fieldset>
            </section>
            <footer className="mabel-modal__foot mabel-modal__foot--split">
              <button type="button" className="mabel-button mabel-button--ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button type="button" className="mabel-button" disabled={!createName.trim() || creating} onClick={() => void handleCreate()}>
                {creating ? "Creating..." : "Create"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        title="Delete project"
        body="The project container will be removed. Its chats and files will stay in Recent and Library."
        confirmLabel="Delete project"
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
