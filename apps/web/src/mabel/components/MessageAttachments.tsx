import { useEffect, useState } from "react";

import { getMabelArtifact, mabelFileUrl } from "../api";
import type { MabelMessageAttachment } from "../types";
import { getAuthHeaders } from "@/lib/auth";

type MessageAttachmentsProps = {
  attachments: MabelMessageAttachment[];
  /** Where this row lives — affects layout density and chip alignment. */
  side: "user" | "assistant";
  /** Opens an authenticated right-side preview for generated assistant files. */
  onOpenFile?: (file: MabelMessageAttachment) => void;
};

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/** Trigger a real file download via fetch+Blob. A plain `<a download>` tag
 *  fails for the Mabel file endpoint because the route requires `X-User-*`
 *  identity headers, which the browser does NOT send for native link
 *  navigation — the cross-origin proxy can drop session cookies too. We
 *  fetch the bytes ourselves with the same auth headers used by every
 *  other API call, then create an object URL and click a hidden <a> so
 *  the browser routes it through the normal Save flow.
 */
async function triggerDownload(url: string, filename: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      return `Download failed: ${response.status}`;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Free the object URL on the next tick — by then the browser has
    // already started the download.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message;
  }
}

/** Render uploaded / agent-generated files attached to a message.
 *
 *  - User-side chips: ChatGPT-style — static, name + size only, no download
 *    icon and no link affordance. The user already has the file locally.
 *  - Assistant-side chips: clickable button that JS-fetches the file with
 *    auth headers, then triggers a real Save-As via a blob URL. This is
 *    the only flow that works through the Vite proxy with the X-User-*
 *    headers our backend requires.
 *  - Images on either side: clickable thumbnail. */
export function MessageAttachments({ attachments, side, onOpenFile }: MessageAttachmentsProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const isUser = side === "user";
  const visibleAttachments = (attachments || []).filter((file, index, list) => {
    const name = (file.name || "").toLowerCase();
    if (!isUser && name.endsWith(".js")) return false;
    return (
      list.findIndex(
        (row) => row.id === file.id || (row.name === file.name && row.mime_type === file.mime_type),
      ) === index
    );
  });
  if (visibleAttachments.length === 0) return null;
  return (
    <div
      className={`mabel-message__attachments mabel-message__attachments--${side}`}
      data-count={visibleAttachments.length}
    >
      {visibleAttachments.map((file) => {
        const isImage = file.mime_type.startsWith("image/");
        const isArtifact = file.mime_type === "application/mabel-artifact";
        const href = file.remote_only || isArtifact ? undefined : mabelFileUrl(file.id);
        if (isImage && href) {
          return (
            <AuthImagePreview
              key={file.id}
              url={href}
              name={file.name}
              title={`${file.name}${file.size_bytes ? ` · ${formatSize(file.size_bytes)}` : ""}`}
              onOpen={onOpenFile && !isUser ? () => onOpenFile(file) : undefined}
            />
          );
        }
        const showDownload = !isUser && Boolean(href);
        const chipBody = (
          <>
            <span className="mabel-message__chip-icon" aria-hidden="true">
              <FileIcon />
            </span>
            <span className="mabel-message__chip-name">{file.name}</span>
            {file.size_bytes ? <span className="mabel-message__chip-meta">{formatSize(file.size_bytes)}</span> : null}
          </>
        );
        // Artifacts: button that opens preview in context rail + download button
        if (isArtifact && !isUser) {
          return (
            <button
              key={file.id}
              type="button"
              className="mabel-message__chip"
              title={errorById[file.id] || file.name}
              disabled={busyId === file.id}
              onClick={() => {
                if (onOpenFile) {
                  onOpenFile(file);
                }
              }}
            >
              {chipBody}
              <span
                className="mabel-message__chip-download"
                role="button"
                aria-label={`Download ${file.name}`}
                title="Download"
                onClick={async (e) => {
                  e.stopPropagation();
                  setBusyId(file.id);
                  setErrorById((prev) => {
                    const { [file.id]: _removed, ...rest } = prev;
                    void _removed;
                    return rest;
                  });
                  try {
                    const artifact = await getMabelArtifact(file.id);
                    const blob = new Blob([artifact.content], { type: "text/html;charset=utf-8" });
                    const objectUrl = URL.createObjectURL(blob);
                    const anchor = document.createElement("a");
                    anchor.href = objectUrl;
                    anchor.download = `${file.name}.html`;
                    document.body.appendChild(anchor);
                    anchor.click();
                    document.body.removeChild(anchor);
                    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                  } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`[mabel] download failed for ${file.name}: ${message}`);
                    setErrorById((prev) => ({ ...prev, [file.id]: message }));
                  }
                  setBusyId(null);
                }}
              >
                <DownloadIcon />
              </span>
            </button>
          );
        }
        // Assistant-side: button that triggers a JS download (auth-aware).
        if (!isUser && href) {
          return (
            <button
              key={file.id}
              type="button"
              className="mabel-message__chip"
              title={errorById[file.id] || file.name}
              disabled={busyId === file.id}
              onClick={async () => {
                if (onOpenFile) {
                  onOpenFile(file);
                  return;
                }
                setBusyId(file.id);
                setErrorById((prev) => {
                  const { [file.id]: _removed, ...rest } = prev;
                  void _removed;
                  return rest;
                });
                const err = await triggerDownload(href, file.name);
                if (err) {
                  console.error(`[mabel] download failed for ${file.name}: ${err}`);
                  setErrorById((prev) => ({ ...prev, [file.id]: err }));
                }
                setBusyId(null);
              }}
            >
              {chipBody}
              {showDownload ? (
                <span
                  className="mabel-message__chip-download"
                  role="button"
                  aria-label={`Download ${file.name}`}
                  title="Download"
                  onClick={async (e) => {
                    e.stopPropagation();
                    setBusyId(file.id);
                    setErrorById((prev) => {
                      const { [file.id]: _removed, ...rest } = prev;
                      void _removed;
                      return rest;
                    });
                    const err = await triggerDownload(href, file.name);
                    if (err) {
                      console.error(`[mabel] download failed for ${file.name}: ${err}`);
                      setErrorById((prev) => ({ ...prev, [file.id]: err }));
                    }
                    setBusyId(null);
                  }}
                >
                  <DownloadIcon />
                </span>
              ) : null}
            </button>
          );
        }
        return (
          <span key={file.id} className="mabel-message__chip" title={file.name}>
            {chipBody}
          </span>
        );
      })}
    </div>
  );
}

function AuthImagePreview({ url, name, title, onOpen }: { url: string; name: string; title: string; onOpen?: () => void }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    fetch(url, { credentials: "include", headers: getAuthHeaders() })
      .then((response) => {
        if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (!alive) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);

  if (error) {
    return (
      <span className="mabel-message__chip" title={error}>
        <span className="mabel-message__chip-icon" aria-hidden="true">
          <FileIcon />
        </span>
        <span className="mabel-message__chip-name">{name}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="mabel-message__image"
      title={title}
      disabled={!objectUrl}
      onClick={() => {
        if (onOpen) {
          onOpen();
          return;
        }
        if (objectUrl) window.open(objectUrl, "_blank", "noopener,noreferrer");
      }}
    >
      {objectUrl ? <img src={objectUrl} alt={name} loading="lazy" /> : <span className="mabel-message__image-loading">Loading image...</span>}
    </button>
  );
}
