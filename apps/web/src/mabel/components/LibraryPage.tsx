import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Library as LibraryEmptyIcon } from "lucide-react";

import { deleteMabelFile, getMabelFiles, uploadMabelFiles } from "../api";
import { fetchMabelCached, getMabelCached, invalidateMabelCache, mabelCacheKey } from "../sessionCache";
import type { MabelUploadedFile } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

type LibraryPageProps = {
  onOpenFile: (file: MabelUploadedFile) => void;
  onChatWithFile: (file: MabelUploadedFile) => void;
  onCountChange?: (count: number) => void;
  onProjectFilesChange?: () => Promise<unknown> | void;
};

type LibraryFilter = "all" | "images" | "documents" | "spreadsheets" | "pdfs";
type LibraryOrigin = "all" | "uploaded" | "generated";

const TYPE_FILTERS: Array<[LibraryFilter, string]> = [
  ["all", "All"],
  ["images", "Images"],
  ["documents", "Documents"],
  ["spreadsheets", "Spreadsheets"],
  ["pdfs", "PDFs"],
];

const ORIGIN_FILTERS: Array<[LibraryOrigin, string]> = [
  ["all", "All sources"],
  ["uploaded", "Uploaded"],
  ["generated", "Generated"],
];

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileCategory(file: MabelUploadedFile): LibraryFilter | "documents" {
  const mime = file.mime_type.toLowerCase();
  const extension = file.name.toLowerCase().split(".").pop() || "";
  if (mime.startsWith("image/")) return "images";
  if (mime.includes("pdf") || extension === "pdf") return "pdfs";
  if (mime.includes("spreadsheet") || mime.includes("excel") || ["csv", "tsv", "xls", "xlsx"].includes(extension)) {
    return "spreadsheets";
  }
  return "documents";
}

function fileTypeLabel(file: MabelUploadedFile): string {
  const extension = file.name.includes(".") ? file.name.split(".").pop() : "";
  if (extension) return extension.toUpperCase().slice(0, 6);
  if (file.mime_type.startsWith("image/")) return "IMAGE";
  return "FILE";
}

function isGeneratedFile(file: MabelUploadedFile): boolean {
  return file.source !== "user_upload";
}

function isLibraryFilter(value: string): value is LibraryFilter {
  return TYPE_FILTERS.some(([filterValue]) => filterValue === value);
}

function isLibraryOrigin(value: string): value is LibraryOrigin {
  return ORIGIN_FILTERS.some(([originValue]) => originValue === value);
}

export function LibraryPage({
  onOpenFile,
  onChatWithFile,
  onCountChange,
  onProjectFilesChange,
}: LibraryPageProps) {
  const [files, setFiles] = useState<MabelUploadedFile[]>(() => getMabelCached<MabelUploadedFile[]>(mabelCacheKey("library")) || []);
  const [loading, setLoading] = useState(() => !getMabelCached<MabelUploadedFile[]>(mabelCacheKey("library")));
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [origin, setOrigin] = useState<LibraryOrigin>("all");
  const [deleteFileTarget, setDeleteFileTarget] = useState<MabelUploadedFile | null>(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMenuRef = useRef<HTMLDivElement | null>(null);

  const loadLibrary = useCallback(async (options: { force?: boolean } = {}) => {
    const cacheKey = mabelCacheKey("library");
    if (!options.force && getMabelCached<MabelUploadedFile[]>(cacheKey)) {
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError("");
    try {
      const nextFiles = await fetchMabelCached(cacheKey, () => getMabelFiles(), { force: options.force });
      setFiles(nextFiles);
      onCountChange?.(nextFiles.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!uploadMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && uploadMenuRef.current?.contains(target)) return;
      setUploadMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUploadMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [uploadMenuOpen]);

  const visibleFiles = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return files.filter((file) => {
      if (filter !== "all" && fileCategory(file) !== filter) return false;
      if (origin === "uploaded" && isGeneratedFile(file)) return false;
      if (origin === "generated" && !isGeneratedFile(file)) return false;
      return !needle || `${file.name} ${file.mime_type}`.toLowerCase().includes(needle);
    });
  }, [files, filter, origin, search]);

  const upload = async (selectedFiles: File[]) => {
    if (selectedFiles.length === 0 || uploading) return;
    setUploading(true);
    setError("");
    setUploadMenuOpen(false);
    try {
      await uploadMabelFiles(selectedFiles);
      invalidateMabelCache(mabelCacheKey("library"));
      await loadLibrary({ force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const confirmFileDelete = async () => {
    if (!deleteFileTarget) return;
    setError("");
    try {
      await deleteMabelFile(deleteFileTarget.id);
      invalidateMabelCache(mabelCacheKey("library"));
      const nextFiles = files.filter((file) => file.id !== deleteFileTarget.id);
      setFiles(nextFiles);
      onCountChange?.(nextFiles.length);
      if (deleteFileTarget.project_id) await onProjectFilesChange?.();
      setDeleteFileTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mabel-page mabel-library-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Library</h1>
          <p>Files and images you can reuse in Mabel whenever you need them.</p>
        </div>
        <div className="mabel-page__actions mabel-library-actions">
          <input
            className="mabel-page__search"
            placeholder="Search library"
            aria-label="Search library"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            className="mabel-page__search mabel-library-range"
            value={filter}
            aria-label="Library file type"
            onChange={(event) => {
              const next = event.target.value;
              if (isLibraryFilter(next)) setFilter(next);
            }}
          >
            {TYPE_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            className="mabel-page__search mabel-library-range"
            value={origin}
            aria-label="Library source"
            onChange={(event) => {
              const next = event.target.value;
              if (isLibraryOrigin(next)) setOrigin(next);
            }}
          >
            {ORIGIN_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <div className="mabel-skill-create" ref={uploadMenuRef}>
            <button
              type="button"
              className="mabel-button"
              disabled={uploading}
              onClick={() => setUploadMenuOpen((open) => !open)}
              aria-expanded={uploadMenuOpen}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>
            {uploadMenuOpen ? (
              <div className="mabel-skill-create__menu" role="menu" aria-label="Upload options">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUploadMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <strong>Files</strong>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUploadMenuOpen(false);
                    folderInputRef.current?.click();
                  }}
                >
                  <strong>Folder</strong>
                </button>
              </div>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const selected = Array.from(event.target.files || []);
              event.target.value = "";
              void upload(selected);
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: "", directory: "" }}
            onChange={(event) => {
              const selected = Array.from(event.target.files || []);
              event.target.value = "";
              void upload(selected);
            }}
          />
        </div>
      </header>

      <div
        className={`mabel-page__body mabel-library-body${dragActive ? " mabel-library-body--drag" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          void upload(Array.from(event.dataTransfer.files || []));
        }}
      >
        {error ? <p className="mabel-page__notice mabel-page__notice--error">{error}</p> : null}

        {dragActive ? <div className="mabel-library-drop">Drop files to add them to Library</div> : null}
        {loading ? (
          <div className="mabel-feature-empty"><span>Loading library...</span></div>
        ) : visibleFiles.length === 0 ? (
          <div className="mabel-feature-empty">
            <span className="mabel-feature-empty__icon"><LibraryEmptyIcon size={28} strokeWidth={1.75} aria-hidden={true} /></span>
            <strong>{files.length === 0 ? "Your library is empty" : "No library items match"}</strong>
            <span>{files.length === 0 ? "Upload files or drop a folder to get started." : "Try another search or filter."}</span>
          </div>
        ) : (
          <section className="mabel-library-grid" aria-label="Library items">
            {visibleFiles.map((file) => (
              <article key={file.id} className="mabel-library-card">
                <button type="button" className="mabel-library-card__preview" onClick={() => onOpenFile(file)}>
                  <span className={`mabel-library-file-icon mabel-library-file-icon--${fileCategory(file)}`}>
                    {fileTypeLabel(file)}
                  </span>
                  <span className="mabel-library-card__copy">
                    <strong>{file.name}</strong>
                    <span>{formatSize(file.size_bytes)} · {formatDate(file.created_at)}</span>
                  </span>
                </button>
                <div className="mabel-library-card__meta">
                  <span>{isGeneratedFile(file) ? "Generated" : "Uploaded"}</span>
                  {file.project_id ? <span>Project file</span> : null}
                </div>
                <div className="mabel-library-card__actions">
                  <button
                    type="button"
                    className="mabel-button mabel-button--ghost"
                    aria-label={`Chat with ${file.name}`}
                    onClick={() => onChatWithFile(file)}
                  >
                    Chat
                  </button>
                  <button type="button" className="mabel-button mabel-button--ghost" onClick={() => onOpenFile(file)}>
                    Preview
                  </button>
                  <button type="button" className="mabel-button mabel-button--ghost mabel-button--danger" onClick={() => setDeleteFileTarget(file)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>

      <ConfirmDialog
        open={deleteFileTarget !== null}
        title="Delete file"
        body="This file will be removed from Library and any chat or project that references it."
        confirmLabel="Delete"
        destructive
        onCancel={() => setDeleteFileTarget(null)}
        onConfirm={() => void confirmFileDelete()}
      />
    </div>
  );
}
