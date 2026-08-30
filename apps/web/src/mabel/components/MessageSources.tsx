import type { MabelSource } from "../types";

type MessageSourcesProps = {
  sources: MabelSource[];
};

function hostFromUrl(url?: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** ChatGPT-style "Sources" strip rendered below an assistant message. Each
 *  source is a compact chip with favicon, title, and host. Clicking opens
 *  the source in a new tab. */
export function MessageSources({ sources }: MessageSourcesProps) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mabel-sources" aria-label="Sources">
      <div className="mabel-sources__label">
        <LinkIcon />
        <span>Sources</span>
        <span className="mabel-sources__count">{sources.length}</span>
      </div>
      <div className="mabel-sources__list">
        {sources.map((source, idx) => {
          const host = hostFromUrl(source.url);
          const label = source.url
            ? host
            : source.title || (source.provider === "oai-weather" ? "OpenAI Weather" : source.provider) || "Source";
          const faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`;
          return source.url ? (
            <a
              key={`${source.url || source.provider || source.title || "source"}-${idx}`}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mabel-source"
              title={source.title || source.url}
            >
              <img
                className="mabel-source__favicon"
                src={faviconUrl}
                alt=""
                aria-hidden="true"
                width={16}
                height={16}
                loading="lazy"
              />
              <span className="mabel-source__body">
                <span className="mabel-source__title">{source.title || host}</span>
                <span className="mabel-source__host">{host}</span>
              </span>
            </a>
          ) : (
            <span
              key={`${source.provider || source.title || "source"}-${idx}`}
              className="mabel-source mabel-source--provider"
              title={source.provider ? `${label} (${source.provider})` : label}
            >
              <span className="mabel-source__favicon mabel-source__favicon--provider" aria-hidden="true" />
              <span className="mabel-source__body">
                <span className="mabel-source__title">{label}</span>
                <span className="mabel-source__host">{source.kind || "api"}</span>
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
