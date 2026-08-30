import { useState, type CSSProperties } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

export type MabelArtifact = {
  language: string;
  value: string;
};

type ArtifactPanelProps = {
  artifact: MabelArtifact;
  theme: "light" | "dark";
  onClose: () => void;
};

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** Decide whether the language can render as a live preview (web) or only as
 *  syntax-highlighted code. HTML / SVG render via srcdoc; everything else
 *  shows code-only. */
function isPreviewable(language: string): boolean {
  const lang = (language || "").toLowerCase();
  return lang === "html" || lang === "xml" || lang === "svg";
}

export function ArtifactPanel({ artifact, theme, onClose }: ArtifactPanelProps) {
  const previewable = isPreviewable(artifact.language);
  const [tab, setTab] = useState<"code" | "preview">(previewable ? "preview" : "code");
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore
    }
  };

  const lines = artifact.value.split("\n").length;
  const bytes = new Blob([artifact.value]).size;

  return (
    <div className="mabel-artifact" data-theme={theme}>
      <div className="mabel-artifact__head">
        <div className="mabel-artifact__title">
          <span className="mabel-artifact__lang">{artifact.language || "text"}</span>
          <span className="mabel-artifact__meta">{lines} lines · {bytes} B</span>
        </div>
        <div className="mabel-artifact__actions">
          {previewable ? (
            <div className="mabel-artifact__tabs" role="tablist" aria-label="Artifact view">
              <button
                type="button"
                className={`mabel-artifact__tab${tab === "preview" ? " mabel-artifact__tab--active" : ""}`}
                role="tab"
                aria-selected={tab === "preview"}
                onClick={() => setTab("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                className={`mabel-artifact__tab${tab === "code" ? " mabel-artifact__tab--active" : ""}`}
                role="tab"
                aria-selected={tab === "code"}
                onClick={() => setTab("code")}
              >
                Code
              </button>
            </div>
          ) : null}
          <button type="button" className="mabel-artifact__copy" onClick={onCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="mabel-icon-btn" onClick={onClose} aria-label="Close canvas" title="Close">
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="mabel-artifact__body">
        {tab === "preview" && previewable ? (
          <iframe
            className="mabel-artifact__preview"
            title="Artifact preview"
            srcDoc={artifact.value}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <SyntaxHighlighter
            language={artifact.language || "text"}
            style={theme === "dark" ? (oneDark as Record<string, CSSProperties>) : (oneLight as Record<string, CSSProperties>)}
            wrapLongLines
            showLineNumbers
            customStyle={{
              margin: 0,
              padding: "12px 14px",
              background: "transparent",
              fontSize: 12.5,
              minHeight: "100%",
            }}
            PreTag="div"
          >
            {artifact.value}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
