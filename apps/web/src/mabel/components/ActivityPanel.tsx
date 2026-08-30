import { useEffect, useMemo, useState } from "react";

import { decideApproval } from "../api";
import type { MabelBootstrap, MabelMessage, MabelToolEvent } from "../types";
import { Markdown } from "./Markdown";

export type ReasoningSnapshot = {
  text: string;
  startedAt: number;
  finishedAt: number | null;
};

export type TurnTiming = {
  startedAt: number;
  firstTokenAt: number | null;
  finishedAt: number | null;
};

type ActivityPanelProps = {
  bootstrap: MabelBootstrap;
  messages: MabelMessage[];
  /** Kept on the prop signature for callers; the Activity panel itself
   *  no longer needs tool events — tools live in the inline MessageSteps
   *  timeline above each assistant message. */
  toolEvents?: MabelToolEvent[];
  reasoningByTurn?: Record<string, ReasoningSnapshot>;
  /** Per assistant-turn timing — when the user pressed Send, when the
   *  first token arrived, when the run finished. Drives the always-on
   *  "Thinking for Ns…" / "Thought for N seconds" entries in the panel. */
  turnTimingByMessageId?: Record<string, TurnTiming>;
  isStreaming?: boolean;
  /** Which assistant message's reasoning to surface. When undefined or
   *  there's no matching message, falls back to the most recent assistant
   *  turn. Used by the inline MessageSteps blocks: clicking a Steps head
   *  switches the Activity panel to that turn's Thinking row. */
  selectedTurnId?: string | null;
  theme?: "light" | "dark";
  onRefresh: () => Promise<void> | void;
  onClose: () => void;
};

/* The Activity panel is now a pure "Thinking" surface — it shows only the
 * agent's reasoning steps. Actions the agent took (tools, sources) live in
 * the inline MessageSteps timeline above each assistant message, since
 * that's where the user expects "what did it do for THIS reply". The
 * Activity rail keeps the "Wrote response" / tool noise out and answers a
 * different question: "what was it thinking?". */
// Each turn produces ONE "Thinking" step. If the model emitted reasoning
// deltas we attach the full chain-of-thought text so the row can expand
// into a prompt-kit Chain-of-Thought block; otherwise the row just shows
// the elapsed think time ("Thought for Ns") with no expansion.
type Step = {
  kind: "thinking";
  id: string;
  startedAt: number;
  endedAt: number | null;
  reasoning?: ReasoningSnapshot;
};

export function ActivityPanel({
  bootstrap,
  messages,
  reasoningByTurn,
  turnTimingByMessageId,
  isStreaming,
  selectedTurnId,
  theme = "light",
  onRefresh,
  onClose,
}: ActivityPanelProps) {
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState<string | null>(null);
  // Tick state used purely to force a re-render every second while a turn
  // is still running, so "Thinking for Ns…" updates live. We only tick
  // while `isStreaming` is true to avoid background re-renders. Putting
  // this in the panel keeps the rest of the app from re-rendering.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isStreaming) return undefined;
    const handle = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(handle);
  }, [isStreaming]);

  const decide = async (id: string, decision: "approved" | "rejected" | "dismissed") => {
    setBusyId(id);
    setError(null);
    setDecisionNote(null);
    try {
      const reason =
        decision === "approved"
          ? "Approved from Mabel Activity panel"
          : decision === "rejected"
            ? "Rejected from Mabel Activity panel"
            : "Dismissed from Mabel Activity panel";
      const result = (await decideApproval(id, decision, reason)) as {
        execution_result?: { status?: string; source?: string };
      };
      if (decision === "approved" && result?.execution_result) {
        const source = result.execution_result.source ? ` via ${result.execution_result.source}` : "";
        setDecisionNote(`Approved and executed${source}.`);
      } else if (decision === "dismissed") {
        setDecisionNote("Approval dismissed.");
      } else {
        setDecisionNote("Approval updated.");
      }
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const steps = useMemo<Step[]>(() => {
    const all: Step[] = [];
    // Walk messages left-to-right so we can pair each assistant with the
    // preceding user — that pair's `created_at` delta is our fallback
    // elapsed clock for hydrated turns that lost their in-session timing.
    let lastUserCreatedAt: number | null = null;
    for (const message of messages) {
      if (message.role === "user") {
        const parsed = message.created_at ? Date.parse(message.created_at) : NaN;
        lastUserCreatedAt = Number.isFinite(parsed) ? parsed : null;
        continue;
      }
      if (message.role !== "assistant") continue;
      const timing = turnTimingByMessageId?.[message.id];
      const reasoning = reasoningByTurn?.[message.id];
      // 1) Prefer in-session live timing (always set on send).
      if (timing) {
        const end = timing.firstTokenAt ?? timing.finishedAt ?? null;
        all.push({
          kind: "thinking",
          id: `t-${message.id}`,
          startedAt: timing.startedAt,
          endedAt: end,
          reasoning: reasoning && reasoning.text.length > 0 ? reasoning : undefined,
        });
        continue;
      }
      const asstCreatedAt = message.created_at ? Date.parse(message.created_at) : NaN;
      // 2) Hydrated history with persisted reasoning: keep the original
      //    elapsed-title behavior from message timestamps, and only attach
      //    reasoning as the expandable detail.
      if (reasoning && reasoning.text.length > 0 && Number.isFinite(asstCreatedAt)) {
        all.push({
          kind: "thinking",
          id: `t-${message.id}`,
          startedAt: lastUserCreatedAt !== null ? lastUserCreatedAt : asstCreatedAt,
          endedAt: asstCreatedAt,
          reasoning,
        });
        continue;
      }
      // 3) Reasoning-only fallback (legacy / mid-session reasoning before
      //    timing was added). Both timestamps come from the reasoning.
      if (reasoning && reasoning.text.length > 0) {
        all.push({
          kind: "thinking",
          id: `t-${message.id}`,
          startedAt: reasoning.startedAt,
          endedAt: reasoning.finishedAt,
          reasoning,
        });
        continue;
      }
      // 4) Hydrated history fallback: estimate elapsed from the gap
      //    between the user message's created_at and the assistant
      //    message's created_at. Without this, Activity is BLANK on
      //    refresh / conversation switch (the in-session timing only
      //    lives in React state, not on the server rows).
      if (Number.isFinite(asstCreatedAt) && lastUserCreatedAt !== null) {
        all.push({
          kind: "thinking",
          id: `t-${message.id}`,
          startedAt: lastUserCreatedAt,
          endedAt: asstCreatedAt,
        });
      } else if (Number.isFinite(asstCreatedAt)) {
        // No user pair (system message? deleted?) — show a 0s entry so the
        // row still renders.
        all.push({
          kind: "thinking",
          id: `t-${message.id}`,
          startedAt: asstCreatedAt,
          endedAt: asstCreatedAt,
        });
      }
    }
    if (all.length === 0) return [];
    if (isStreaming) return [all[all.length - 1]];
    if (selectedTurnId) {
      const wantedId = `t-${selectedTurnId}`;
      const match = all.find((step) => step.id === wantedId);
      if (match) return [match];
    }
    return [all[all.length - 1]];
  }, [messages, reasoningByTurn, turnTimingByMessageId, selectedTurnId, isStreaming]);

  // Total elapsed time across all turns this session — title shows
  // "Activity · 3s" so the user can tell at a glance how much agent
  // wall-clock time has been spent. Matches prompt-kit's Steps elapsed
  // marker. Sums all turns, not just reasoning.
  const totalThinkingSeconds = useMemo(() => {
    let totalMs = 0;
    for (const step of steps) {
      const end = step.endedAt ?? Date.now();
      totalMs += Math.max(0, end - step.startedAt);
    }
    return totalMs > 0 ? Math.max(1, Math.round(totalMs / 1000)) : null;
  }, [steps]);

  const hasApprovals = bootstrap.approvals.length > 0;
  const empty = steps.length === 0 && !hasApprovals;

  return (
    <div className="mabel-activity">
      <div className="mabel-activity__head">
        <h3 className="mabel-activity__title">
          Activity
          {totalThinkingSeconds !== null ? (
            <span className="mabel-activity__elapsed">{` · ${totalThinkingSeconds}s`}</span>
          ) : null}
        </h3>
        <button type="button" className="mabel-icon-btn" onClick={onClose} aria-label="Close activity panel" title="Close">
          <CloseIcon />
        </button>
      </div>

      <div className="mabel-activity__body">
        {hasApprovals ? (
          <section className="mabel-activity__approvals">
            {error ? <div className="mabel-form__error">{error}</div> : null}
            {decisionNote ? <div className="mabel-muted">{decisionNote}</div> : null}
            <ul className="mabel-activity__list">
              {bootstrap.approvals.map((approval) => (
                <li key={approval.id} className="mabel-activity__row">
                  <div className="mabel-activity__row-main">
                    <strong>{approval.title}</strong>
                    <span className="mabel-activity__row-meta">{approval.requested_by || "—"}</span>
                  </div>
                  {approval.summary ? <p className="mabel-muted">{approval.summary}</p> : null}
                  {(approval.payload?.tool_name || approval.payload?.scope || approval.payload?.server_slug) ? (
                    <p className="mabel-muted">
                      {approval.payload?.tool_name ? `Tool: ${approval.payload.tool_name}` : ""}
                      {approval.payload?.scope ? ` · Scope: ${approval.payload.scope}` : ""}
                      {approval.payload?.server_slug ? ` · Connector: ${approval.payload.server_slug}` : ""}
                    </p>
                  ) : null}
                  <div className="mabel-activity__row-actions">
                    <button
                      type="button"
                      className="mabel-button"
                      disabled={busyId === approval.id}
                      onClick={() => decide(approval.id, "approved")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="mabel-button mabel-button--ghost"
                      disabled={busyId === approval.id}
                      onClick={() => decide(approval.id, "rejected")}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="mabel-button mabel-button--ghost"
                      disabled={busyId === approval.id}
                      onClick={() => decide(approval.id, "dismissed")}
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {empty ? null : (
          <section className="mabel-activity__thinking">
            <ol className="mabel-cot">
              {steps.map((step) => (
                <CotStep
                  key={step.id}
                  step={step}
                  open={openStep === step.id}
                  onToggle={() => setOpenStep((prev) => (prev === step.id ? null : step.id))}
                  theme={theme}
                />
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

function CotStep({
  step,
  open,
  onToggle,
  theme,
}: {
  step: Step;
  open: boolean;
  onToggle: () => void;
  theme: "light" | "dark";
}) {
  const isRunning = step.endedAt === null;
  const elapsedMs = (step.endedAt ?? Date.now()) - step.startedAt;
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  const title = isRunning
    ? `Thinking for ${seconds}s…`
    : `Thought for ${seconds === 1 ? "a second" : `${seconds} seconds`}`;
  const hasReasoning = !!step.reasoning && step.reasoning.text.length > 0;
  return (
    <li className="mabel-cot__step mabel-cot__step--reasoning">
      <div className="mabel-cot__head">
        <span
          className={`mabel-cot__dot mabel-cot__dot--${isRunning ? "running" : "done"}`}
          aria-hidden="true"
        >
          {isRunning ? <Spinner /> : <CheckIcon />}
        </span>
        {hasReasoning ? (
          <button
            type="button"
            className={`mabel-cot__row${open ? " mabel-cot__row--open" : ""}`}
            onClick={onToggle}
            aria-expanded={open}
          >
            <div className="mabel-cot__body">
              <div className="mabel-cot__title">{title}</div>
            </div>
            <ChevronIcon open={open} />
          </button>
        ) : (
          <div className="mabel-cot__row mabel-cot__row--static">
            <div className="mabel-cot__body">
              <div className="mabel-cot__title">{title}</div>
            </div>
          </div>
        )}
      </div>
      {open && hasReasoning ? (
        <div className="mabel-cot__detail">
          <Markdown content={step.reasoning!.text} theme={theme} />
        </div>
      ) : null}
    </li>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
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
      className={`mabel-cot__chevron${open ? " mabel-cot__chevron--open" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
