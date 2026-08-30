import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Check, Copy } from "lucide-react";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { mabelCodeToHtml } from "@/lib/mabelCodeShiki";

export type MarkdownArtifact = {
  language: string;
  value: string;
};

type MarkdownProps = {
  content: string;
  theme: "light" | "dark";
  /** If provided, every fenced code block gets an "Expand" button that opens
   *  the block in the artifact canvas. */
  onOpenArtifact?: (artifact: MarkdownArtifact) => void;
};

/** Collapse the loose-list / trailing-<br> patterns GPT-5.5 emits in chat:
 *
 *  1. Runs of 3+ newlines → 2 (extra newlines render as empty <p> elements).
 *  2. Trailing leading blank lines (a tool-using turn often opens with one).
 *  3. Blank lines before list openers (`\n\n- foo` → `\n- foo`) so list
 *     items render as a tight list rather than each wrapped in a <p>.
 *  4. Hard-line-break markers (`  \n`) — markdown's two-trailing-spaces +
 *     newline produces a <br> which forces each list item to render as
 *     two lines (description on one line, link on the next), inflating
 *     visible item height to ~30px. We drop the trailing spaces so the
 *     continuation joins onto the same line. */
function normalizeMarkdown(src: string): string {
  if (!src) return src;
  let out = src.replace(/\r\n/g, "\n");
  out = stripMabelInternalAnswerNoise(out);
  // Kill trailing-whitespace hard line breaks. Two-or-more spaces + newline
  // is the only way to produce a markdown <br>; without those spaces the
  // newline just joins lines with a space (CommonMark soft-wrap).
  out = out.replace(/[ \t]{2,}\n/g, "\n");
  // Reasoning summaries can stream section headings directly after prose,
  // e.g. `done.**Planning dashboard creation**`. Restore the paragraph
  // break without changing the text.
  out = out.replace(/([.!?])(?=\*\*[A-Z][^*\n]{2,80}\*\*)/g, "$1\n\n");
  out = out.replace(/(\*\*[A-Z][^*\n]{2,80}\*\*)(?=[A-Z][a-z])/g, "$1\n\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/^\s*\n+/, "");
  out = out.replace(/\n{2,}(\s*(?:[-*+]|\d+\.)\s)/g, "\n$1");
  // Strip a model-emitted trailing "Source(s): ..." line — citations now
  // live in the inline MessageSteps "Searched the web" block and the
  // model frequently duplicates them at the end of the reply (as a plain
  // paragraph OR a bullet point). We only strip when it's the final line
  // of the message so we don't damage real prose.
  out = out.replace(
    /\n+\s*(?:[-*+]\s+)?\*{0,2}Sources?\*{0,2}\s*:?[^\n]*$/i,
    "",
  );
  // Strip ":" inline "Download <filename>" markdown links (sandbox: /
  // download:// URLs that don't actually work). The agent-generated file
  // chip below the bubble already provides a real downloadable button.
  // We replace the markdown link with just its label so the sentence
  // still reads naturally but isn't a broken hyperlink.
  out = out.replace(
    /\[\s*(Download[^\]]*?)\s*\]\(\s*(?:sandbox|download|file|attachment):[^)]*\)/gi,
    "$1",
  );
  return out;
}

function stripMabelInternalAnswerNoise(src: string): string {
  const lines = src.split("\n");
  const kept: string[] = [];
  let skipNextFence = false;
  let skippingFence = false;
  const noisyLine = /^\s*(?:[-*+]\s+)?(?:Full(?:[- ]scope| scoped dataset)? requested|Records returned by analysis|Dashboard rows returned inline|Evidence rows displayed inline|Returned in dashboard|Evidence display rows|Full export|Full dashboard export|Retrieval caveat)\b/i;
  const noisyCaveat = /^\s*(?:[-*+]\s+)?(?:The tool output was very large and truncated in-chat|Some support-team fields were null|Some snippets are partial transcript excerpts|I normalized ["“]?(?:Expert AI|X Bert|AI receptionist))/i;
  for (const line of lines) {
    if (skippingFence) {
      if (/^\s*```/.test(line)) {
        skippingFence = false;
      }
      continue;
    }
    if (skipNextFence) {
      if (!line.trim() || /^[,)]\s*$/.test(line.trim())) continue;
      if (/^\s*```/.test(line)) {
        skippingFence = true;
        skipNextFence = false;
        continue;
      }
      skipNextFence = false;
    }
    if (noisyLine.test(line) || noisyCaveat.test(line)) {
      skipNextFence = true;
      continue;
    }
    if (/^\s*```/.test(line) && kept.length > 0) {
      const previous = kept[kept.length - 1] || "";
      if (/^\s*(?:[-*+]\s+)?(?:Full export|Full dashboard export)\b/i.test(previous)) {
        kept.pop();
        skippingFence = true;
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function salesforceLinkForId(value: string): string | null {
  const id = value.trim();
  const baseUrl = (import.meta.env.VITE_MABEL_SALESFORCE_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) return null;
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id)) return null;
  const prefix = id.slice(0, 3);
  const objectName = prefix === "00U" ? "Event" : prefix === "00T" ? "Task" : prefix === "006" ? "Opportunity" : prefix === "001" ? "Account" : null;
  return objectName ? `${baseUrl}/lightning/r/${objectName}/${id}/view` : null;
}

function supportLinkForValue(value: string): string | null {
  const cleaned = value.trim();
  if (/^\/support\/agent\/[^\s]+\/call\/[^\s]+/i.test(cleaned)) return cleaned;
  return null;
}

function generatedExportPath(value: string): boolean {
  return /\/workspace\/mabel\/exports\/mcp-evidence\/.*\.(?:csv|json)$/i.test(value.trim());
}

function linkedScalar(value: string) {
  const salesforceHref = salesforceLinkForId(value);
  if (salesforceHref) {
    return (
      <a href={salesforceHref} target="_blank" rel="noopener noreferrer">
        {value.trim()}
      </a>
    );
  }
  const supportHref = supportLinkForValue(value);
  if (supportHref) {
    return (
      <a href={supportHref} target="_blank" rel="noopener noreferrer">
        Open call
      </a>
    );
  }
  if (generatedExportPath(value)) {
    return <span>Attached CSV export</span>;
  }
  return null;
}

function linkTextScalars(value: string): ReactNode {
  const exact = linkedScalar(value);
  if (exact) return exact;

  const parts: ReactNode[] = [];
  const pattern = /(^|[^A-Za-z0-9])([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)(?=$|[^A-Za-z0-9])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const id = match[2];
    const idStart = match.index + match[1].length;
    const href = salesforceLinkForId(id);
    if (!href) continue;
    if (idStart > lastIndex) parts.push(value.slice(lastIndex, idStart));
    parts.push(
      <a key={`${id}-${idStart}`} href={href} target="_blank" rel="noopener noreferrer">
        {id}
      </a>,
    );
    lastIndex = idStart + id.length;
  }
  if (parts.length === 0) return value;
  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return parts;
}

function linkTableCellChildren(children: ReactNode): ReactNode {
  if (typeof children === "string") return linkTextScalars(children);
  if (Array.isArray(children)) {
    return children.flatMap((child) => {
      const linked = linkTableCellChildren(child);
      return Array.isArray(linked) ? linked : [linked];
    });
  }
  return children;
}

/** Single-line ```text``` fences that are clearly scalar values (tool ids,
 * UUIDs, numeric ids, Salesforce keys, emails, ISO dates) render inline — not Prompt Kit
 * cards. Multi-line or non-plain fences stay full blocks. */
function shouldRenderFenceAsCompactInline(value: string, languageId: string): boolean {
  const v = value.replace(/\n$/, "").trim();
  if (!v || v.includes("\n")) return false;
  const lang = (languageId || "text").trim().toLowerCase();
  if (!["text", "txt", "plain", ""].includes(lang)) return false;

  if (v.length > 200) return false;

  // MCP and field identifiers.
  if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(v)) return true;
  // Case numbers, limits, counts
  if (/^\d{1,24}$/.test(v)) return true;
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  // Salesforce-style 15- or 18-char ids (e.g. 005UV000002M2d7YAC)
  if (/^[a-z0-9]{15}$|^[a-z0-9]{18}$/i.test(v)) return true;
  // Single-line email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return true;
  // ISO date (model often fences examples like 2026-06-01)
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;

  return false;
}

export function Markdown({ content, theme, onOpenArtifact }: MarkdownProps) {
  const normalized = normalizeMarkdown(content);
  const components: Components = {
    // CommonMark wraps fenced blocks in <pre><code>…</code></pre>. We render
    // prompt-kit–style cards, so the outer <pre> is replaced with a div.
    pre({ children }: { children?: ReactNode }) {
      return <div className="mabel-markdown-pre">{children}</div>;
    },
    code({ inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || "");
      const value = String(children ?? "").replace(/\n$/, "");
      if (!inline) {
        const language = match ? match[1] : "text";
        const linked = linkedScalar(value);
        if (linked) return linked;
        if (shouldRenderFenceAsCompactInline(value, language)) {
          return (
            <code className="mabel-markdown-inline-code" {...props}>
              {value}
            </code>
          );
        }
        return (
          <CodeBlock
            language={language}
            value={value}
            theme={theme}
            onOpenArtifact={onOpenArtifact}
          />
        );
      }
      const linked = linkedScalar(value);
      if (linked) return linked;
      const merged = ["mabel-markdown-inline-code", className].filter(Boolean).join(" ");
      return (
        <code className={merged} {...props}>
          {children}
        </code>
      );
    },
    a({ children, href, ...props }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },
    td({ children, ...props }) {
      return <td {...props}>{linkTableCellChildren(children)}</td>;
    },
    th({ children, ...props }) {
      return <th {...props}>{linkTableCellChildren(children)}</th>;
    },
  };

  return (
    <div className={`mabel-markdown mabel-markdown--${theme}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

function formatLangBadge(languageId: string, isPlain: boolean): string {
  if (isPlain) return "Text";
  const k = languageId.trim().toLowerCase();
  if (!k) return "Code";
  const pretty: Record<string, string> = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    tsx: "TSX",
    jsx: "JSX",
    json: "JSON",
    jsonc: "JSONC",
    python: "Python",
    bash: "Bash",
    shell: "Shell",
    yaml: "YAML",
    markdown: "Markdown",
    sql: "SQL",
    graphql: "GraphQL",
    vue: "Vue",
    html: "HTML",
    css: "CSS",
    scss: "SCSS",
    xml: "XML",
    diff: "Diff",
  };
  if (pretty[k]) return pretty[k];
  if (k.length <= 4) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1).toLowerCase();
}

function CodeBlock({
  language,
  value,
  theme,
  onOpenArtifact,
}: {
  language: string;
  value: string;
  theme: "light" | "dark";
  onOpenArtifact?: (artifact: MarkdownArtifact) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [shikiHtml, setShikiHtml] = useState<string | null>(null);
  const lineCount = value.split("\n").length;
  const normalizedLang = language.trim().toLowerCase();
  const isPlainText =
    normalizedLang === "text" || normalizedLang === "txt" || normalizedLang === "plain";
  const displayLang = isPlainText ? "Plain text" : language.trim() || "Plain text";
  const highlighterLang = isPlainText ? "text" : language.trim() || "text";
  const badge = formatLangBadge(displayLang, isPlainText);
  const canExpand = Boolean(onOpenArtifact) && (lineCount >= 8 || value.length >= 280);

  useEffect(() => {
    if (isPlainText) {
      setShikiHtml(null);
      return;
    }
    let cancelled = false;
    setShikiHtml(null);
    void mabelCodeToHtml(value, highlighterLang, theme).then((html) => {
      if (!cancelled) setShikiHtml(html);
    });
    return () => {
      cancelled = true;
    };
  }, [value, highlighterLang, theme, isPlainText]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore
    }
  };

  return (
    <div className="mabel-code mabel-code--promptkit">
      <div className="mabel-code__group">
        <span className="mabel-code__badge">{badge}</span>
        <div className="mabel-code__actions">
          {canExpand ? (
            <button
              type="button"
              className="mabel-code__icon-btn mabel-code__expand"
              onClick={() => onOpenArtifact!({ language: highlighterLang, value })}
              aria-label="Open in canvas"
              title="Open in canvas"
            >
              <ExpandIcon />
            </button>
          ) : null}
          <button type="button" className="mabel-code__icon-btn" onClick={onCopy} aria-label="Copy" title="Copy">
            {copied ? <Check size={13} strokeWidth={2.25} /> : <Copy size={13} strokeWidth={2} />}
          </button>
        </div>
      </div>
      <div className="mabel-code__body">
        {isPlainText ? (
          <pre className="mabel-code__pre">{value}</pre>
        ) : shikiHtml ? (
          <div className="mabel-code__shiki" dangerouslySetInnerHTML={{ __html: shikiHtml }} />
        ) : (
          <pre className="mabel-code__pre mabel-code__pre--skeleton">{value}</pre>
        )}
      </div>
    </div>
  );
}
