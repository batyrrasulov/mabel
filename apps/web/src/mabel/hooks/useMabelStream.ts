import { useCallback, useRef, useState } from "react";

import { runStartMyDayDemoStream, sendMabelMessage } from "../api";
import type { MabelMessage, MabelMessageAttachment, MabelStreamEvent, MabelSurface, MabelToolEvent } from "../types";

export type MabelSendOptions = {
  /** Refs to previously uploaded files (must be uploaded via uploadMabelFiles first). */
  attachmentIds?: string[];
  /** Display metadata for chips on the user bubble. Optional — display-only. */
  userAttachments?: MabelMessageAttachment[];
  /** Saved Mabel notes passed as user-context, never agent instructions. */
  documentIds?: string[];
  /** Optional project workspace for a newly-created conversation. */
  projectId?: string;
};

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export type MabelStreamOptions = {
  instructions?: () => string | undefined;
  /**
   * Fires when a NEW chat is sent (no existing conversation_id). The UI uses this to
   * optimistically insert a placeholder row into the conversation list BEFORE the
   * network round-trip for instant left-rail feedback.
   */
  onSendStarted?: (firstUserMessage: string) => void;
  /**
   * Fires when the backend confirms the new conversation id (run_started event).
   * The UI uses this to swap the optimistic row's id, refresh from server, and reorder
   * the rail to put the active chat on top.
   */
  onConversationCreated?: (conversationId: number, firstUserMessage: string) => void;
  /** Fires for every confirmed run, including follow-ups in an existing conversation. */
  onRunStarted?: (conversationId: number, firstUserMessage: string, isNewConversation: boolean) => void;
  /** Fires after the SSE stream completes (success, stop, or error). */
  onRunCompleted?: () => void;
};

function isHiddenGeneratedAttachment(file: MabelMessageAttachment): boolean {
  const name = (file.name || "").toLowerCase();
  return file.source !== "user_upload" && name.endsWith(".js");
}

function normalizeSources(sources: MabelMessage["sources"] | undefined): MabelMessage["sources"] {
  if (!sources || sources.length === 0) return sources;
  const hasUrl = sources.some((source) => typeof source.url === "string" && /^https?:\/\//.test(source.url));
  return hasUrl ? sources.filter((source) => typeof source.url === "string" && /^https?:\/\//.test(source.url)) : sources;
}

export function useMabelStream(surface: MabelSurface, options: MabelStreamOptions = {}) {
  const [messages, setMessages] = useState<MabelMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<MabelToolEvent[]>([]);
  const [reasoningByTurn, setReasoningByTurn] = useState<Record<string, { text: string; startedAt: number; finishedAt: number | null }>>({});
  // Per-turn timing — `startedAt` is when the user pressed Send; `firstTokenAt`
  // is when the first token of the assistant reply arrived. Used by the
  // Activity panel to show a live "Thinking for Ns…" counter and a final
  // "Thought for N seconds" stamp on every turn (even ones with no
  // reasoning deltas). Captured here because the timing data isn't
  // recoverable from message rows alone.
  const [turnTimingByMessageId, setTurnTimingByMessageId] = useState<
    Record<string, { startedAt: number; firstTokenAt: number | null; finishedAt: number | null }>
  >({});
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const instructionsRef = useRef(options.instructions);
  instructionsRef.current = options.instructions;
  const onSendStartedRef = useRef(options.onSendStarted);
  onSendStartedRef.current = options.onSendStarted;
  const onConversationCreatedRef = useRef(options.onConversationCreated);
  onConversationCreatedRef.current = options.onConversationCreated;
  const onRunStartedRef = useRef(options.onRunStarted);
  onRunStartedRef.current = options.onRunStarted;
  const onRunCompletedRef = useRef(options.onRunCompleted);
  onRunCompletedRef.current = options.onRunCompleted;

  const send = useCallback(
    async (text: string, options: MabelSendOptions = {}) => {
      const trimmed = text.trim();
      const userAttachments = options.userAttachments ?? [];
      const attachmentIds = options.attachmentIds ?? [];
      // Allow attachment-only sends (no text) — that's a valid ChatGPT-style flow.
      if (!trimmed && attachmentIds.length === 0) return;
      if (isStreaming) return;

      const assistantId = id("assistant");
      const turnStartedAt = Date.now();
      setMessages((prev) => [
        ...prev,
        {
          id: id("user"),
          role: "user",
          content: trimmed,
          attachments: userAttachments.length > 0 ? userAttachments : undefined,
        },
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setTurnTimingByMessageId((prev) => ({
        ...prev,
        [assistantId]: { startedAt: turnStartedAt, firstTokenAt: null, finishedAt: null },
      }));
      setError(null);
      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const currentConversationId = activeConversationId ?? undefined;
      const isNewConversation = currentConversationId === undefined;
      const pendingGeneratedAttachments: MabelMessageAttachment[] = [];
      const queueGeneratedAttachment = (next: MabelMessageAttachment) => {
        if (isHiddenGeneratedAttachment(next)) return;
        const alreadyExists = pendingGeneratedAttachments.some(
          (row) => row.id === next.id || (row.name === next.name && row.mime_type === next.mime_type && row.source === next.source),
        );
        if (!alreadyExists) pendingGeneratedAttachments.push(next);
      };
      // Optimistic conversation insertion: notify the UI BEFORE the network call
      // so the left rail can show the new chat row instantly.
      if (isNewConversation) {
        onSendStartedRef.current?.(trimmed || userAttachments[0]?.name || "Attachment");
      }

      try {
        await sendMabelMessage(
          trimmed,
          surface,
          (event) => {
            if (event.type === "run_started" && typeof event.conversation_id === "number") {
              setActiveConversationId(event.conversation_id);
              onRunStartedRef.current?.(event.conversation_id, trimmed || userAttachments[0]?.name || "Attachment", isNewConversation);
              if (isNewConversation) {
                onConversationCreatedRef.current?.(event.conversation_id, trimmed || userAttachments[0]?.name || "Attachment");
              }
            }
            if (event.type === "token") {
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === assistantId
                    ? { ...message, content: `${message.content}${event.text}` }
                    : message,
                ),
              );
              // First token → the "thinking" phase ends. Freeze the
              // Thought-for clock to (firstTokenAt - startedAt).
              setTurnTimingByMessageId((prev) => {
                const existing = prev[assistantId];
                if (!existing || existing.firstTokenAt !== null) return prev;
                return {
                  ...prev,
                  [assistantId]: { ...existing, firstTokenAt: Date.now() },
                };
              });
            }
            if (event.type === "reasoning") {
              setReasoningByTurn((prev) => {
                const existing = prev[assistantId];
                const now = Date.now();
                return {
                  ...prev,
                  [assistantId]: {
                    text: (existing?.text || "") + event.text,
                    startedAt: existing?.startedAt ?? now,
                    finishedAt: null,
                  },
                };
              });
            }
            if (event.type === "sources") {
              const normalized = normalizeSources(event.sources);
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === assistantId
                    ? { ...message, sources: normalized }
                    : message,
                ),
              );
            }
            if (event.type === "agent_file") {
              queueGeneratedAttachment({
                id: event.file_id,
                name: event.name,
                mime_type: event.mime,
                source: event.kind === "image" ? "agent_image" : "agent_code_file",
                remote_only: event.remote_only,
              });
            }
            if (event.type === "artifact_created") {
              queueGeneratedAttachment({
                id: event.artifact_id,
                name: event.title,
                mime_type: "application/mabel-artifact",
                source: "mabel_artifact",
                size_bytes: event.size_bytes,
              });
            }
            if (event.type === "error") {
              const message = event.message || "Mabel could not complete the request.";
              setError(message);
              setMessages((prev) =>
                prev.map((item) =>
                  item.id === assistantId && !item.content ? { ...item, content: "Mabel could not complete the request." } : item,
                ),
              );
            }
            if (event.type === "tool_call" || event.type === "tool_result" || event.type === "approval_requested") {
              setToolEvents((prev) => [
                ...prev,
                {
                  id: id(event.type),
                  type: event.type,
                  tool_name: event.tool_name,
                  tool_call_id: event.tool_call_id,
                  approval_id: event.type === "approval_requested" ? event.approval_id : undefined,
                  detail:
                    event.type === "tool_result"
                      ? event.output_preview
                      : JSON.stringify(event.arguments || {}),
                  turn_id: assistantId,
                },
              ]);
            }
          },
          currentConversationId,
          {
            signal: controller.signal,
            instructions: instructionsRef.current?.(),
            attachments: attachmentIds.length > 0 ? attachmentIds.map((id) => ({ id })) : undefined,
            documents: options.documentIds?.map((id) => ({ id })),
            projectId: options.projectId,
          },
        );
      } catch (err) {
        if (controller.signal.aborted) {
          setMessages((prev) =>
            prev.map((item) =>
              item.id === assistantId && !item.content ? { ...item, content: "Stopped." } : item,
            ),
          );
        } else {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setMessages((prev) =>
            prev.map((item) =>
              item.id === assistantId && !item.content ? { ...item, content: "Mabel could not complete the request." } : item,
            ),
          );
        }
      } finally {
        if (pendingGeneratedAttachments.length > 0) {
          setMessages((prev) =>
            prev.map((message) => {
              if (message.id !== assistantId) return message;
              const existing = message.attachments || [];
              const nextAttachments = pendingGeneratedAttachments.filter(
                (file) => !existing.some((row) => row.id === file.id || (row.name === file.name && row.mime_type === file.mime_type && row.source === file.source)),
              );
              return nextAttachments.length > 0 ? { ...message, attachments: [...existing, ...nextAttachments] } : message;
            }),
          );
        }
        setIsStreaming(false);
        abortRef.current = null;
        // Freeze the reasoning duration so the Activity step shows
        // "Thought for Ns" instead of an ever-growing timer.
        setReasoningByTurn((prev) => {
          if (!prev[assistantId]) return prev;
          if (prev[assistantId].finishedAt != null) return prev;
          return {
            ...prev,
            [assistantId]: { ...prev[assistantId], finishedAt: Date.now() },
          };
        });
        // Freeze the turn's wall-clock so the Activity's Thought-for-Ns
        // step has a stable final number. If no token ever arrived (e.g.
        // immediate failure), set firstTokenAt = finishedAt so the panel
        // shows a sane elapsed instead of "Thinking…" forever.
        setTurnTimingByMessageId((prev) => {
          const existing = prev[assistantId];
          if (!existing) return prev;
          const now = Date.now();
          return {
            ...prev,
            [assistantId]: {
              startedAt: existing.startedAt,
              firstTokenAt: existing.firstTokenAt ?? now,
              finishedAt: now,
            },
          };
        });
        onRunCompletedRef.current?.();
      }
    },
    [activeConversationId, isStreaming, surface],
  );

  const runStartMyDayDemo = useCallback(async () => {
    const trimmed = "Start my day";
    if (isStreaming) return;

    const assistantId = id("assistant");
    const turnStartedAt = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: id("user"), role: "user", content: trimmed },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setTurnTimingByMessageId((prev) => ({
      ...prev,
      [assistantId]: { startedAt: turnStartedAt, firstTokenAt: null, finishedAt: null },
    }));
    setError(null);
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const isNewConversation = activeConversationId === undefined;
    if (isNewConversation) {
      onSendStartedRef.current?.(trimmed);
    }

    const handleEvent = (event: MabelStreamEvent) => {
      if (event.type === "run_started" && typeof event.conversation_id === "number") {
        setActiveConversationId(event.conversation_id);
        onRunStartedRef.current?.(event.conversation_id, trimmed, isNewConversation);
        if (isNewConversation) {
          onConversationCreatedRef.current?.(event.conversation_id, trimmed);
        }
      }
      if (event.type === "token") {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId ? { ...message, content: `${message.content}${event.text}` } : message,
          ),
        );
        setTurnTimingByMessageId((prev) => {
          const existing = prev[assistantId];
          if (!existing || existing.firstTokenAt !== null) return prev;
          return { ...prev, [assistantId]: { ...existing, firstTokenAt: Date.now() } };
        });
      }
      if (event.type === "error") {
        const message = event.message || "Mabel could not complete the request.";
        setError(message);
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantId && !item.content ? { ...item, content: "Mabel could not complete the request." } : item,
          ),
        );
      }
      if (event.type === "tool_call" || event.type === "tool_result" || event.type === "approval_requested") {
        setToolEvents((prev) => [
          ...prev,
          {
            id: id(event.type),
            type: event.type,
            tool_name: event.tool_name,
            tool_call_id: event.tool_call_id,
            approval_id: event.type === "approval_requested" ? event.approval_id : undefined,
            detail:
              event.type === "tool_result"
                ? event.output_preview
                : JSON.stringify(event.arguments || {}),
            turn_id: assistantId,
          },
        ]);
      }
    };

    try {
      await runStartMyDayDemoStream(handleEvent, { signal: controller.signal });
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantId && !item.content ? { ...item, content: "Mabel could not complete the request." } : item,
          ),
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      setReasoningByTurn((prev) => {
        if (!prev[assistantId]) return prev;
        if (prev[assistantId].finishedAt != null) return prev;
        return { ...prev, [assistantId]: { ...prev[assistantId], finishedAt: Date.now() } };
      });
      setTurnTimingByMessageId((prev) => {
        const existing = prev[assistantId];
        if (!existing) return prev;
        const now = Date.now();
        return {
          ...prev,
          [assistantId]: {
            startedAt: existing.startedAt,
            firstTokenAt: existing.firstTokenAt ?? now,
            finishedAt: now,
          },
        };
      });
      onRunCompletedRef.current?.();
    }
  }, [activeConversationId, isStreaming]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setToolEvents([]);
    setReasoningByTurn({});
    setTurnTimingByMessageId({});
    setError(null);
    setActiveConversationId(null);
  }, []);

  const hydrateConversation = useCallback(
    (
      conversationId: number,
      rows: MabelMessage[],
      tools: MabelToolEvent[] = [],
      reasoning: Record<string, { text: string; startedAt: number; finishedAt: number | null }> = {},
    ) => {
      abortRef.current?.abort();
      setActiveConversationId(conversationId);
      setMessages(rows);
      setToolEvents(tools);
      setReasoningByTurn(reasoning);
      setTurnTimingByMessageId({});
      setError(null);
    },
    [],
  );

  const regenerateLast = useCallback(async () => {
    if (isStreaming) return;
    let lastUserText: string | null = null;
    setMessages((prev) => {
      const next = [...prev];
      while (next.length > 0 && next[next.length - 1].role !== "user") {
        next.pop();
      }
      if (next.length > 0 && next[next.length - 1].role === "user") {
        lastUserText = next[next.length - 1].content;
        next.pop();
      }
      return next;
    });
    if (lastUserText) {
      await send(lastUserText);
    }
  }, [isStreaming, send]);

  return {
    messages,
    toolEvents,
    reasoningByTurn,
    turnTimingByMessageId,
    isStreaming,
    error,
    send,
    runStartMyDayDemo,
    stop,
    startNewChat,
    activeConversationId,
    hydrateConversation,
    regenerateLast,
  };
}
