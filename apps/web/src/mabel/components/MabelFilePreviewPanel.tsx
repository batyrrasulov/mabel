import { useEffect, useMemo, useState } from "react";

import { mabelFilePreviewPdfUrl, mabelFilePreviewUrl, mabelFileUrl, getMabelArtifact } from "../api";
import type { MabelMessageAttachment } from "../types";
import { getAuthHeaders } from "@/lib/auth";
import { Markdown } from "./Markdown";

type MabelFilePreviewPanelProps = {
  file: MabelMessageAttachment;
  onClose: () => void;
};

type RenderKind =
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "markdown"
  | "html"
  | "csv"
  | "image"
  | "text"
  | "unsupported";

const TEXT_PREVIEW_BUDGET = 200_000;
const fileBlobCache = new Map<string, Blob>();
const officePdfCache = new Map<string, Blob>();
const officeHtmlCache = new Map<string, string>();

function classifyFile(file: MabelMessageAttachment): RenderKind {
  // Mabel artifacts are stored as HTML
  if (file.mime_type === "application/mabel-artifact") {
    return "html";
  }
  const mime = (file.mime_type || "").toLowerCase();
  const ext = (file.name || "").toLowerCase().split(".").pop() || "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.includes("wordprocessingml") || ext === "docx") return "docx";
  if (mime.includes("presentationml") || mime.includes("powerpoint") || ext === "pptx") return "pptx";
  if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || ext === "xlsx" || ext === "xls") {
    return "xlsx";
  }
  if (mime.includes("markdown") || ext === "md" || ext === "markdown") return "markdown";
  if (mime.includes("html") || ext === "html" || ext === "htm") return "html";
  if (mime.includes("csv") || ext === "csv" || ext === "tsv") return "csv";
  if (mime.startsWith("image/") || /^(png|jpe?g|gif|webp|svg)$/.test(ext)) return "image";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || /^(txt|md|json|xml|csv|tsv|drawio|svg|html?)$/.test(ext)) {
    return "text";
  }
  return "unsupported";
}

function fileBadge(file: MabelMessageAttachment): string {
  // Mabel artifacts store HTML content
  if (file.mime_type === "application/mabel-artifact") return "HTML";
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  if (ext) return ext.toUpperCase().slice(0, 6);
  const mime = file.mime_type.toLowerCase();
  if (mime.includes("pdf")) return "PDF";
  if (mime.includes("wordprocessingml")) return "DOCX";
  if (mime.includes("presentationml") || mime.includes("powerpoint")) return "PPTX";
  if (mime.includes("spreadsheet")) return "XLSX";
  if (mime.startsWith("image/")) return "IMG";
  return "FILE";
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchMabelFile(fileId: string): Promise<Blob> {
  const response = await fetch(mabelFileUrl(fileId), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`File fetch failed: ${response.status}`);
  return response.blob();
}

async function fetchMabelArtifactBlob(artifactId: string): Promise<Blob> {
  const artifact = await getMabelArtifact(artifactId);
  if (!artifact.content) throw new Error("Artifact has no content");
  // Artifacts store content as strings; convert to blob
  return new Blob([artifact.content], { type: "text/html;charset=utf-8" });
}

async function downloadMabelFile(file: MabelMessageAttachment): Promise<string | null> {
  try {
    const isArtifact = file.mime_type === "application/mabel-artifact";
    const blob = isArtifact ? await fetchMabelArtifactBlob(file.id) : await fetchMabelFile(file.id);
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = isArtifact ? `${file.name}.html` : file.name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function MabelFilePreviewPanel({ file, onClose }: MabelFilePreviewPanelProps) {
  const kind = useMemo(() => classifyFile(file), [file]);
  const badge = fileBadge(file);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    let alive = true;
    const useCache = reloadCounter === 0;
    if (useCache) {
      const cached = fileBlobCache.get(file.id);
      if (cached) {
        setBlob(cached);
        setLoading(false);
        setError(null);
        return () => {
          alive = false;
        };
      }
    }
    setLoading(true);
    setError(null);
    setBlob(null);
    const isArtifact = file.mime_type === "application/mabel-artifact";
    const fetchFn = isArtifact ? fetchMabelArtifactBlob : fetchMabelFile;
    fetchFn(file.id)
      .then((nextBlob) => {
        if (!alive) return;
        fileBlobCache.set(file.id, nextBlob);
        setBlob(nextBlob);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [file.id, reloadCounter]);

  return (
    <div className="mabel-file-preview">
      <header className="mabel-file-preview__head">
        <div className="mabel-file-preview__title">
          <div>
            <strong title={file.name}>{file.name}</strong>
            <span>{badge}{formatSize(file.size_bytes) ? ` · ${formatSize(file.size_bytes)}` : ""}</span>
          </div>
        </div>
        <div className="mabel-file-preview__actions">
          <button type="button" className="mabel-icon-btn" onClick={() => setReloadCounter((n) => n + 1)} aria-label="Refresh file preview" title="Refresh">
            <RefreshIcon />
          </button>
          {(kind === "html" || kind === "text") && (
            <button
              type="button"
              className="mabel-icon-btn"
              onClick={() => setShowCode(!showCode)}
              aria-label={showCode ? "Hide code" : "Show code"}
              title={showCode ? "Hide code" : "Show code"}
            >
              <CodeIcon />
            </button>
          )}
          <button
            type="button"
            className="mabel-icon-btn"
            onClick={async () => {
              setDownloadError(null);
              const nextError = await downloadMabelFile(file);
              if (nextError) setDownloadError(nextError);
            }}
            aria-label="Download file"
            title="Download"
          >
            <DownloadIcon />
          </button>
          <button type="button" className="mabel-icon-btn" onClick={onClose} aria-label="Close file preview" title="Close">
            <CloseIcon />
          </button>
        </div>
      </header>
      {downloadError ? <div className="mabel-file-preview__error">Download failed: {downloadError}</div> : null}
      <div className="mabel-file-preview__body">
        {loading ? <div className="mabel-file-preview__status">Loading {badge.toLowerCase()} preview...</div> : null}
        {!loading && error ? <div className="mabel-file-preview__status mabel-file-preview__status--error">Could not load file: {error}</div> : null}
        {!loading && !error && blob ? <FileRenderer file={file} kind={kind} blob={blob} badge={badge} showCode={showCode} /> : null}
      </div>
    </div>
  );
}

function FileRenderer({ file, kind, blob, badge, showCode }: { file: MabelMessageAttachment; kind: RenderKind; blob: Blob; badge: string; showCode: boolean }) {
  if (kind === "pdf") return <PdfRenderer blob={blob} />;
  if (kind === "docx") return <OfficeRenderer fileId={file.id} badge={badge} />;
  if (kind === "pptx") return <OfficeRenderer fileId={file.id} badge={badge} />;
  if (kind === "xlsx") return <XlsxRenderer blob={blob} />;
  if (kind === "markdown") return <MarkdownRenderer blob={blob} />;
  if (kind === "html") return <HtmlRenderer blob={blob} showCode={showCode} />;
  if (kind === "csv") return <CsvRenderer blob={blob} />;
  if (kind === "image") return <ImageRenderer blob={blob} />;
  if (kind === "text") return <TextRenderer blob={blob} showCode={showCode} />;
  return (
    <div className="mabel-file-preview__status">
      In-browser preview is not available for {badge} files. Use Download to open it locally.
    </div>
  );
}

function OfficeRenderer({ fileId, badge }: { fileId: string; badge: string }) {
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cachedPdf = officePdfCache.get(fileId);
    if (cachedPdf) {
      setPdfBlob(cachedPdf);
      setHtml("");
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    const cachedHtml = officeHtmlCache.get(fileId);
    if (cachedHtml) {
      setPdfBlob(null);
      setHtml(cachedHtml);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      // Prefer high-fidelity PDF conversion (LibreOffice headless) first.
      try {
        const pdfResponse = await fetch(mabelFilePreviewPdfUrl(fileId), {
          credentials: "include",
          headers: getAuthHeaders(),
        });
        if (pdfResponse.ok) {
          const nextPdfBlob = await pdfResponse.blob();
          if (!cancelled) {
            officePdfCache.set(fileId, nextPdfBlob);
            setPdfBlob(nextPdfBlob);
          }
          return;
        }
      } catch (err) {
        // fall through to HTML preview fallback
        void err;
      }
      try {
        const htmlResponse = await fetch(mabelFilePreviewUrl(fileId), {
          credentials: "include",
          headers: getAuthHeaders(),
        });
        if (!htmlResponse.ok) throw new Error(`Preview failed: ${htmlResponse.status}`);
        const nextHtml = await htmlResponse.text();
        if (!cancelled) {
          officeHtmlCache.set(fileId, nextHtml);
          setHtml(nextHtml);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  if (pdfBlob) return <PdfRenderer blob={pdfBlob} />;
  if (error) return <div className="mabel-file-preview__status mabel-file-preview__status--error">{badge} preview failed: {error}</div>;
  if (!html) return <div className="mabel-file-preview__status">Rendering {badge.toLowerCase()} preview...</div>;
  return <iframe className="mabel-file-preview__office-frame" title={`${badge} preview`} sandbox="" srcDoc={html} />;
}

function PdfRenderer({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  if (!url) return <div className="mabel-file-preview__status">Loading PDF preview...</div>;
  const viewerUrl = `${url}#zoom=page-width`;
  return (
    <iframe
      className="mabel-file-preview__office-frame"
      title="PDF preview"
      src={viewerUrl}
    />
  );
}

function XlsxRenderer({ blob }: { blob: Blob }) {
  return (
    <div className="mabel-file-preview__status">
      Spreadsheet preview is disabled because no security-maintained browser parser is bundled.
      Download the {Math.max(1, Math.round(blob.size / 1024))} KB file to inspect it locally.
    </div>
  );
}

function MarkdownRenderer({ blob }: { blob: Blob }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await blob.text();
        if (!cancelled) setText(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);
  if (error) return <div className="mabel-file-preview__status mabel-file-preview__status--error">Markdown preview failed: {error}</div>;
  return (
    <div className="mabel-file-preview__markdown">
      <div className="mabel-file-preview__doc-page">
        <Markdown content={text} theme="light" />
      </div>
    </div>
  );
}

function HtmlRenderer({ blob, showCode }: { blob: Blob; showCode: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [rawHtml, setRawHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    blob.text().then((raw) => {
      if (!cancelled) {
        setRawHtml(raw);
        setHtml(wrapHtmlForPreview(raw));
      }
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [blob]);

  const handleCopy = async () => {
    if (!rawHtml) return;
    try {
      await navigator.clipboard.writeText(rawHtml);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  if (error) return <div className="mabel-file-preview__status mabel-file-preview__status--error">HTML preview failed: {error}</div>;
  if (!html) return <div className="mabel-file-preview__status">Rendering HTML preview...</div>;
  if (showCode && rawHtml) {
    return (
      <div className="mabel-file-preview__text mabel-file-preview__text--code">
        <button
          type="button"
          className={`mabel-file-preview__copy-btn ${copyFeedback ? 'copied' : ''}`}
          onClick={handleCopy}
          title={copyFeedback ? "Copied!" : "Copy code"}
          aria-label="Copy code to clipboard"
        >
          {copyFeedback ? "Copied" : <CopyIcon />}
        </button>
        <pre>{rawHtml}</pre>
      </div>
    );
  }
  return <iframe className="mabel-file-preview__office-frame" title="HTML preview" sandbox="" srcDoc={html} />;
}

function wrapHtmlForPreview(rawHtml: string): string {
  const hasHtmlShell = /<html[\s>]/i.test(rawHtml) || /<body[\s>]/i.test(rawHtml);
  if (hasHtmlShell) return rawHtml;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; background: #f2f4f7; font-family: "Segoe UI", Arial, sans-serif; color: #0f172a; }
    .page {
      width: min(780px, calc(100% - 24px));
      margin: 16px auto;
      background: #fff;
      border: 1px solid #e4e7ec;
      border-radius: 4px;
      box-shadow: 0 10px 30px rgba(16, 24, 40, 0.1);
      padding: 34px 40px;
      min-height: 88vh;
      overflow-wrap: anywhere;
    }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    td, th { border: 1px solid #d0d5dd; padding: 7px 10px; text-align: left; }
    th { background: #f8fafc; }
  </style>
</head>
<body><main class="page">${rawHtml}</main></body></html>`;
}

function CsvRenderer({ blob }: { blob: Blob }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [totalRows, setTotalRows] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setTotalRows(0);
    setError(null);
    (async () => {
      try {
        const text = await blob.text();
        const nextRows = parseCsvRows(text).filter((row) => row.some((cell) => cell.trim().length > 0));
        if (!cancelled) {
          setTotalRows(nextRows.length);
          setRows(nextRows.slice(0, 501));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);
  if (error) return <div className="mabel-file-preview__status mabel-file-preview__status--error">CSV preview failed: {error}</div>;
  if (rows === null) return <div className="mabel-file-preview__status">Parsing CSV...</div>;
  if (rows.length === 0) return <div className="mabel-file-preview__status">No CSV rows found.</div>;
  return (
    <>
      {totalRows > rows.length ? (
        <div className="mabel-file-preview__status">Previewing first {rows.length - 1} rows. Download the CSV for all {totalRows - 1} rows.</div>
      ) : null}
      <div className="mabel-file-preview__sheet">
        <StructuredTable rows={rows} />
      </div>
    </>
  );
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function StructuredTable({ rows }: { rows: string[][] }) {
  if (!rows || rows.length === 0) return null;
  const header = rows[0] || [];
  const body = rows.slice(1);
  const hasHeader = header.some((cell) => cell.trim().length > 0);
  return (
    <table>
      {hasHeader ? (
        <thead>
          <tr>
            {header.map((cell, idx) => (
              <th key={`h-${idx}`}>{cell}</th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {(hasHeader ? body : rows).map((row, idx) => (
          <tr key={`${idx}-${row.length}`}>
            {row.map((cell, col) => (
              <td key={`${idx}-${col}`}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ImageRenderer({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  if (!url) return null;
  return (
    <div className="mabel-file-preview__image">
      <img src={url} alt="File preview" />
    </div>
  );
}

function TextRenderer({ blob, showCode }: { blob: Blob; showCode: boolean }) {
  const [text, setText] = useState("");
  const [rawText, setRawText] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const slice = blob.size > TEXT_PREVIEW_BUDGET ? blob.slice(0, TEXT_PREVIEW_BUDGET) : blob;
        const raw = await slice.text();
        if (cancelled) return;
        setRawText(raw);
        const trimmed = raw.trim();
        let display = raw;
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            display = JSON.stringify(JSON.parse(trimmed), null, 2);
          } catch {
            display = raw;
          }
        }
        setText(display);
        setTruncated(blob.size > TEXT_PREVIEW_BUDGET);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

  const handleCopy = async () => {
    const displayText = showCode ? rawText : text;
    if (!displayText) return;
    try {
      await navigator.clipboard.writeText(displayText);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  if (error) return <div className="mabel-file-preview__status mabel-file-preview__status--error">Text preview failed: {error}</div>;
  const displayText = showCode ? rawText : text;
  return (
    <div className="mabel-file-preview__text mabel-file-preview__text--code">
      {(showCode || text === displayText) && (
        <button
          type="button"
          className={`mabel-file-preview__copy-btn ${copyFeedback ? 'copied' : ''}`}
          onClick={handleCopy}
          title={copyFeedback ? "Copied!" : "Copy code"}
          aria-label="Copy code to clipboard"
        >
          {copyFeedback ? "Copied" : <CopyIcon />}
        </button>
      )}
      <pre>{displayText}</pre>
      {truncated ? <p>Preview truncated to {Math.round(TEXT_PREVIEW_BUDGET / 1024)} KB. Download for the full file.</p> : null}
    </div>
  );
}
