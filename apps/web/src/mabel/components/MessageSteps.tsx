import { useState } from "react";

import { type MabelSource, type MabelToolEvent } from "../types";

type ToolGroup = { key: string; name: string; events: MabelToolEvent[] };

type ToolState = "running" | "completed" | "approval" | "error";

function groupTools(events: MabelToolEvent[]): ToolGroup[] {
  const out: ToolGroup[] = [];
  events.forEach((event) => {
    const key = event.tool_call_id || event.tool_name;
    let group = out.find((g) => g.key === key);
    if (!group) {
      group = { key, name: event.tool_name, events: [] };
      out.push(group);
    }
    group.events.push(event);
  });
  return out;
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

const SKILL_LABELS: Record<string, string> = {
  "skill.start-my-day": "Meeting prep briefing",
  "skill.product-usage": "Product usage summaries",
};

function skillLabelFromGroup(group: ToolGroup): string | null {
  const call = group.events.find((e) => e.type === "tool_call");
  if (!call?.detail) return null;
  try {
    const args = JSON.parse(call.detail) as Record<string, unknown>;
    const skillId = typeof args.skill_id === "string" ? args.skill_id.trim() : "";
    if (skillId && SKILL_LABELS[skillId]) return SKILL_LABELS[skillId];
    return skillId || null;
  } catch {
    return null;
  }
}

/** Natural-language title for the action. Past tense when completed,
 *  present tense while running — matches prompt-kit Steps. No "tool"
 *  terminology surfaced to the user. */
function describeAction(toolName: string, state: ToolState, group?: ToolGroup): string {
  const past = state !== "running";
  switch (toolName) {
    case "web_search":
    case "web_search_call":
      return past ? "Searched the web" : "Searching the web";
    case "code_interpreter":
    case "code_interpreter_call":
      return past ? "Ran code" : "Running code";
    case "image_generation":
    case "image_generation_call":
      return past ? "Generated image" : "Generating image";
    case "file_read":
      return past ? "Read attached file" : "Reading attached file";
    case "file_search":
    case "file_search_call":
      return past ? "Searched files" : "Searching files";
    case "mabel_context":
      return past ? "Read workspace context" : "Reading workspace context";
    case "mabel_search_skills":
      return past ? "Searched skills" : "Searching skills";
    case "mabel_start_my_day_brief":
      return past ? "Drafted start-of-day brief" : "Drafting start-of-day brief";
    case "outlook_calendar.list_events":
      return past ? "Checked Outlook calendar" : "Checking Outlook calendar";
    case "salesforce.get_account":
      return past ? "Pulled Salesforce account" : "Pulling Salesforce account";
    case "microsoft_teams.get_meeting_notes":
      return past ? "Read Teams notes" : "Reading Teams notes";
    case "product_usage.get_account_summary":
      return past ? "Summarized product usage" : "Summarizing product usage";
    case "mabel_get_skill": {
      const label = group ? skillLabelFromGroup(group) : null;
      if (label) return past ? `Loaded ${label} skill` : `Loading ${label} skill`;
      return past ? "Loaded workflow skill" : "Loading workflow skill";
    }
    default:
      return past ? `Used ${toolName}` : `Calling ${toolName}`;
  }
}

/** Build the human-readable sub-lines that appear under a Steps title.
 *  Pulls the most useful bits from the tool's args + output preview without
 *  exposing raw JSON. */
function extractSubLines(group: ToolGroup): string[] {
  const lines: string[] = [];
  const call = group.events.find((e) => e.type === "tool_call");
  const result = group.events.find((e) => e.type === "tool_result");

  if (call?.detail) {
    try {
      const args = JSON.parse(call.detail) as Record<string, unknown>;
      if (typeof args.query === "string" && args.query.trim().length > 0) {
        lines.push(`Query: ${args.query.trim()}`);
      } else if (Array.isArray(args.queries) && args.queries.length > 0) {
        const queries = args.queries
          .map((value) => String(value).trim())
          .filter(Boolean)
          .join(", ");
        if (queries) lines.push(`Query: ${queries}`);
      } else if (typeof args.account === "string" && args.account.trim().length > 0) {
        lines.push(args.account.trim());
      } else if (typeof args.account_id === "string" && args.account_id.trim().length > 0) {
        lines.push(`Account ID: ${args.account_id.trim()}`);
      } else if (Array.isArray(args.accounts) && args.accounts.length > 0) {
        lines.push(args.accounts.map((value) => String(value).trim()).filter(Boolean).join(", "));
      } else if (typeof args.skill_id === "string" && args.skill_id.trim().length > 0) {
        const skillId = args.skill_id.trim();
        const label = SKILL_LABELS[skillId] || skillId;
        if (!group.name.includes("mabel_get_skill")) {
          lines.push(label);
        }
      } else if (typeof args.start === "string" && typeof args.end === "string") {
        lines.push(`Today (${args.start.slice(0, 10)})`);
      } else if (Array.isArray(args.files) && args.files.length > 0) {
        const names = args.files.map((f) => String(f)).join(", ");
        lines.push(names);
      } else if (typeof args.code === "string" && args.code.trim().length > 0) {
        const code = args.code.trim();
        lines.push(code.length > 120 ? `${code.slice(0, 120)}…` : code);
      } else if (typeof args.source === "string" && args.source.trim().length > 0) {
        lines.push(`Source: ${args.source.trim()}`);
      }
    } catch {
      // Ignore unparseable args — the title alone is informative enough.
    }
  }

  if (result?.detail) {
    const text = result.detail.trim();
    if (text && text !== "{}" && text !== "[]") {
      // Cap each preview line so the Steps block never sprawls.
      const preview = text.length > 240 ? `${text.slice(0, 240)}…` : text;
      // Avoid duplicating sub-lines we already added from the args.
      if (!lines.some((l) => preview.startsWith(l) || l.startsWith(preview))) {
        lines.push(preview);
      }
    }
  }

  return lines;
}

function extractCreatedSkillId(group: ToolGroup): string | null {
  if (group.name !== "mabel_create_skill") return null;
  const result = group.events.find((e) => e.type === "tool_result");
  const detail = (result?.detail || "").trim();
  if (!detail) return null;
  const direct = detail.match(/\bskill\.[a-z0-9._-]+\b/i)?.[0];
  if (direct) return direct;
  try {
    const parsed = JSON.parse(detail) as {
      skill?: { id?: string };
      result?: { skill?: { id?: string } };
    };
    const nested = parsed.skill?.id || parsed.result?.skill?.id || "";
    return nested.trim() || null;
  } catch {
    return null;
  }
}

function hostFromUrl(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function sourceLabel(source: MabelSource): string {
  if (source.url) return hostFromUrl(source.url);
  return source.title || (source.provider === "oai-weather" ? "OpenAI Weather" : source.provider) || "Source";
}

function sourceTitle(source: MabelSource): string {
  if (source.url) return source.title || source.url;
  const label = sourceLabel(source);
  return source.provider ? `${label} (${source.provider})` : label;
}

function sourceKey(source: MabelSource, idx: number): string {
  return `${source.url || source.provider || source.title || "source"}-${idx}`;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 160ms ease" }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mabel-steps__spinner"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function StepsBlock({
  group,
  sources,
  onActivate,
  onOpenSkill,
}: {
  group: ToolGroup;
  sources?: MabelSource[];
  onActivate?: () => void;
  onOpenSkill?: (skillId: string) => void;
}) {
  const state = deriveState(group.events);
  const isRunning = state === "running";
  const title = describeAction(group.name, state, group);
  const lines = extractSubLines(group);
  const createdSkillId = extractCreatedSkillId(group);
  const hasSources = (sources?.length || 0) > 0;
  const expandable = lines.length > 0 || hasSources;
  const [open, setOpen] = useState(false);
  return (
    <div className="mabel-steps" data-state={state}>
      <button
        type="button"
        className="mabel-steps__head"
        onClick={() => {
          // Always tell the parent to focus this turn in the Activity
          // panel (one Thinking row per turn). Toggle the inline body
          // independently — even when there's nothing to expand we still
          // want the click to switch Activity to this message.
          onActivate?.();
          if (expandable) setOpen((value) => !value);
        }}
        aria-expanded={open}
      >
        <span className="mabel-steps__title">{title}</span>
        <span className="mabel-steps__indicator" aria-hidden="true">
          {isRunning ? <Spinner /> : null}
          {expandable ? <ChevronIcon open={open} /> : null}
        </span>
      </button>
      {open && expandable ? (
        <div className="mabel-steps__body">
          {lines.map((line, idx) => (
            <div key={idx} className="mabel-steps__row">
              {line}
            </div>
          ))}
          {hasSources ? (
            <div className="mabel-steps__sources">
              {(sources || []).map((source, idx) => (
                <SourceChip key={sourceKey(source, idx)} source={source} />
              ))}
            </div>
          ) : null}
          {createdSkillId && onOpenSkill ? (
            <div className="mabel-steps__sources">
              <button
                type="button"
                className="mabel-button mabel-button--ghost"
                onClick={() => onOpenSkill(createdSkillId)}
              >
                View skill
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SourceChip({ source }: { source: MabelSource }) {
  const label = sourceLabel(source);
  const title = sourceTitle(source);
  if (source.url) {
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mabel-steps__source"
        title={title}
      >
        <SourceFavicon url={source.url} />
        <span className="mabel-steps__source-host">{label}</span>
      </a>
    );
  }
  return (
    <span className="mabel-steps__source mabel-steps__source--provider" title={title}>
      <span className="mabel-steps__provider-dot" aria-hidden="true" />
      <span className="mabel-steps__source-host">{label}</span>
    </span>
  );
}

function SourceFavicon({ url }: { url: string }) {
  const host = hostFromUrl(url);
  return (
    <span className="mabel-steps__favicon" aria-hidden="true">
      {host.charAt(0).toUpperCase()}
    </span>
  );
}

function SourceOnlyBlock({ sources }: { sources: MabelSource[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mabel-steps" data-state="completed">
      <button
        type="button"
        className="mabel-steps__head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="mabel-steps__title">Sources</span>
        <span className="mabel-steps__indicator" aria-hidden="true">
          <ChevronIcon open={open} />
        </span>
      </button>
      {open ? (
        <div className="mabel-steps__body">
          <div className="mabel-steps__sources">
            {sources.map((source, idx) => (
              <SourceChip key={sourceKey(source, idx)} source={source} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Renders the prompt-kit Steps timeline ABOVE the assistant message — one
 *  block per tool the agent used this turn, in chronological order. The
 *  last block attaches the message's web-search sources as inline chips.
 *
 *  Activity panel still owns the "Thinking / Thought for Ns" reasoning;
 *  this component owns the "what the agent did" surface. Clicking any
 *  Steps head fires `onActivate` so the Activity panel can switch its
 *  single visible Thinking row to this turn. */
export function MessageSteps({
  toolEvents,
  sources,
  onActivate,
  onOpenSkill,
}: {
  toolEvents: MabelToolEvent[];
  sources?: MabelSource[];
  onActivate?: () => void;
  onOpenSkill?: (skillId: string) => void;
}) {
  const groups = groupTools(toolEvents);
  const hasSources = (sources?.length || 0) > 0;
  let lastWebSearchIndex = -1;
  groups.forEach((group, idx) => {
    if (group.name === "web_search" || group.name === "web_search_call") lastWebSearchIndex = idx;
  });
  const sourceGroupIndex = hasSources ? (lastWebSearchIndex >= 0 ? lastWebSearchIndex : groups.length - 1) : -1;
  if (groups.length === 0 && !hasSources) return null;
  if (groups.length === 0 && hasSources) {
    return (
      <div className="mabel-steps-list">
        <SourceOnlyBlock sources={sources || []} />
      </div>
    );
  }
  return (
    <div className="mabel-steps-list">
      {groups.map((group, idx) => (
        <StepsBlock
          key={group.key}
          group={group}
          sources={idx === sourceGroupIndex ? sources : undefined}
          onActivate={onActivate}
          onOpenSkill={onOpenSkill}
        />
      ))}
    </div>
  );
}
