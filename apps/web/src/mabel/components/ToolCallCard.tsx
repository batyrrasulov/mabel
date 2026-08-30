import { useState } from "react";

import type { MabelToolEvent } from "../types";

type ToolCallCardProps = {
  toolName: string;
  events: MabelToolEvent[];
  defaultOpen?: boolean;
  /** Fired any time the header is clicked. Lets the parent surface the
   *  Activity panel even when the user manually closed it. */
  onHeaderClick?: () => void;
};

type ToolState = "running" | "completed" | "approval" | "error";

/** Render a tool-call payload as a flat list of key:value rows for objects,
 *  pretty-printed JSON for arrays, and verbatim for strings. Matches the
 *  prompt-kit Tool component's expanded body look. */
function formatBlock(
  value: string | undefined,
): { kind: "kv"; rows: Array<[string, string]> } | { kind: "code"; text: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Truly empty payloads (no JSON, just braces, etc.) — let the parent render
  // a "No arguments." / "No output captured." placeholder instead of a
  // pointless gray code block with literal "{}".
  if (!trimmed || trimmed === "{}" || trimmed === "[]" || trimmed === "null") return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || parsed === undefined) return null;
    if (typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length === 0) return null;
      const allShallow = entries.every(
        ([, v]) =>
          v === null || ["string", "number", "boolean"].includes(typeof v),
      );
      if (allShallow) {
        return {
          kind: "kv",
          rows: entries.map(([k, v]) => [k, v === null || v === undefined ? "—" : String(v)]),
        };
      }
    }
    return { kind: "code", text: JSON.stringify(parsed, null, 2) };
  } catch {
    return { kind: "code", text: trimmed };
  }
}

function deriveState(events: MabelToolEvent[]): ToolState {
  const hasError = events.some(
    (e) => e.type === "tool_result" && /(^|[^a-z])error([^a-z]|$)/i.test(e.detail || ""),
  );
  if (hasError) return "error";
  if (events.some((e) => e.type === "approval_requested")) return "approval";
  if (events.some((e) => e.type === "tool_result")) return "completed";
  return "running";
}

function stateLabel(state: ToolState): string {
  switch (state) {
    case "running":
      return "Running";
    case "approval":
      return "Awaiting approval";
    case "error":
      return "Error";
    case "completed":
    default:
      return "Completed";
  }
}

function Section({ label, block, fallback }: { label: string; block: ReturnType<typeof formatBlock>; fallback: string }) {
  return (
    <div className="mabel-tool-card__section">
      <div className="mabel-tool-card__section-label">{label}</div>
      {block === null ? (
        <div className="mabel-tool-card__empty">{fallback}</div>
      ) : block.kind === "kv" ? (
        <div className="mabel-tool-card__kv">
          {block.rows.map(([k, v]) => (
            <div key={k} className="mabel-tool-card__kv-row">
              <span className="mabel-tool-card__kv-key">{k}:</span>
              <span className="mabel-tool-card__kv-val">{v}</span>
            </div>
          ))}
        </div>
      ) : (
        <pre className="mabel-tool-card__pre">{block.text}</pre>
      )}
    </div>
  );
}

export function ToolCallCard({ toolName, events, defaultOpen = false, onHeaderClick }: ToolCallCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const state = deriveState(events);

  const callEvent = events.find((event) => event.type === "tool_call");
  const resultEvent = events.find((event) => event.type === "tool_result");
  const approvalEvent = events.find((event) => event.type === "approval_requested");

  const inputBlock = formatBlock(callEvent?.detail);
  const outputBlock = formatBlock(resultEvent?.detail);
  const approvalBlock = formatBlock(approvalEvent?.detail);

  return (
    <article className="mabel-tool-card" data-state={state}>
      <button
        type="button"
        className="mabel-tool-card__header"
        onClick={() => {
          setIsOpen((value) => !value);
          onHeaderClick?.();
        }}
        aria-expanded={isOpen}
      >
        <span className="mabel-tool-card__name">{toolName}</span>
        <span className={`mabel-tool-pill mabel-tool-pill--${state}`}>
          <span className="mabel-tool-pill__icon" aria-hidden="true">
            {state === "running" ? (
              <Spinner />
            ) : state === "error" ? (
              <XIcon />
            ) : state === "approval" ? (
              <ClockIcon />
            ) : (
              <CheckIcon />
            )}
          </span>
          <span className="mabel-tool-pill__label">{stateLabel(state)}</span>
        </span>
        <span className={`mabel-tool-card__chevron${isOpen ? " mabel-tool-card__chevron--open" : ""}`} aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      {isOpen ? (
        <div className="mabel-tool-card__body">
          <Section
            label="Input"
            block={inputBlock}
            fallback={state === "running" ? "Awaiting arguments…" : "No arguments."}
          />
          <Section
            label="Output"
            block={outputBlock}
            fallback={state === "running" ? "Streaming…" : "No output captured."}
          />
          {approvalBlock || approvalEvent ? (
            <Section label="Approval" block={approvalBlock} fallback="Pending approval." />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Spinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
