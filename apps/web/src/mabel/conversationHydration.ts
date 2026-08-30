import type { MabelConversationMessages, MabelMessage, MabelMessageAttachment, MabelToolEvent } from "./types";

function normalizeSources(sources: MabelMessage["sources"]): MabelMessage["sources"] {
  if (!sources || sources.length === 0) return sources;
  const hasUrl = sources.some((source) => typeof source.url === "string" && /^https?:\/\//.test(source.url));
  return hasUrl ? sources.filter((source) => typeof source.url === "string" && /^https?:\/\//.test(source.url)) : sources;
}

function isHiddenGeneratedAttachment(file: MabelMessageAttachment): boolean {
  const name = (file.name || "").toLowerCase();
  return file.source !== "user_upload" && name.endsWith(".js");
}

function previewRank(file: MabelMessageAttachment): number {
  const name = (file.name || "").toLowerCase();
  const mime = (file.mime_type || "").toLowerCase();
  if (file.source === "mabel_artifact") return 0;
  if (mime.includes("html") || name.endsWith(".html") || name.includes("dashboard")) return 1;
  if (mime.includes("csv") || name.endsWith(".csv")) return 4;
  return 2;
}

function sortPreviewableAttachments(files: MabelMessageAttachment[]): MabelMessageAttachment[] {
  return [...files].sort((a, b) => previewRank(a) - previewRank(b));
}

export type HydratedConversation = {
  messageRows: MabelMessage[];
  tools: MabelToolEvent[];
  hydratedReasoning: Record<string, { text: string; startedAt: number; finishedAt: number | null }>;
  projectId: string | null;
  openContext: boolean;
};

export function hydrateConversationPayload(payload: MabelConversationMessages): HydratedConversation {
  if (!payload?.messages) {
    return {
      messageRows: [],
      tools: [],
      hydratedReasoning: {},
      projectId: payload?.conversation?.project_id || null,
      openContext: false,
    };
  }
  const messageRows: MabelMessage[] = payload.messages.map((row) => ({
    id: `msg-${row.id}`,
    role: row.role,
    content: row.content,
    sources: normalizeSources(row.sources && row.sources.length > 0 ? row.sources : undefined),
    created_at: row.created_at,
  }));

  const runToAssistant = new Map<string, string>();
  const runToUser = new Map<string, string>();
  payload.messages.forEach((row, idx) => {
    const targetId = messageRows[idx].id;
    if (!row.run_id) return;
    if (row.role === "assistant") runToAssistant.set(row.run_id, targetId);
    if (row.role === "user") runToUser.set(row.run_id, targetId);
  });

  const assistantIds = messageRows.filter((row) => row.role === "assistant").map((row) => row.id);
  const userIds = messageRows.filter((row) => row.role === "user").map((row) => row.id);
  const runOrder: string[] = [];
  (payload.tool_calls ?? []).forEach((row) => {
    if (!runOrder.includes(row.run_id)) runOrder.push(row.run_id);
  });
  (payload.files ?? []).forEach((row) => {
    if (row.run_id && !runOrder.includes(row.run_id)) runOrder.push(row.run_id);
  });
  let fallbackIndex = 0;
  for (const runId of runOrder) {
    if (runToAssistant.has(runId)) continue;
    while (fallbackIndex < assistantIds.length && [...runToAssistant.values()].includes(assistantIds[fallbackIndex])) {
      fallbackIndex += 1;
    }
    if (fallbackIndex < assistantIds.length) {
      runToAssistant.set(runId, assistantIds[fallbackIndex]);
      if (fallbackIndex < userIds.length && !runToUser.has(runId)) {
        runToUser.set(runId, userIds[fallbackIndex]);
      }
      fallbackIndex += 1;
    }
  }
  const runToTurn = runToAssistant;

  const filesByMessage = new Map<string, MabelMessageAttachment[]>();
  const artifactsWithoutRunId: MabelMessageAttachment[] = [];

  for (const row of payload.files ?? []) {
    const nextAttachment: MabelMessageAttachment = {
      id: row.id,
      name: row.name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      source: row.source,
    };

    if (isHiddenGeneratedAttachment(nextAttachment)) continue;

    if (!row.run_id) {
      if (row.source === "mabel_artifact") {
        artifactsWithoutRunId.push(nextAttachment);
      }
      continue;
    }

    const isAgentSource = row.source?.startsWith("agent_");
    const targetMessage = isAgentSource ? runToAssistant.get(row.run_id) : runToUser.get(row.run_id);
    if (!targetMessage) continue;

    const bucket = filesByMessage.get(targetMessage) || [];
    const alreadyExists = bucket.some(
      (item) => item.id === nextAttachment.id || (item.name === nextAttachment.name && item.mime_type === nextAttachment.mime_type),
    );
    if (alreadyExists) continue;
    bucket.push(nextAttachment);
    filesByMessage.set(targetMessage, bucket);
  }

  if (artifactsWithoutRunId.length > 0) {
    const lastAssistantMessage = [...messageRows].reverse().find((row) => row.role === "assistant");
    if (lastAssistantMessage) {
      const bucket = filesByMessage.get(lastAssistantMessage.id) || [];
      for (const artifact of artifactsWithoutRunId) {
        const alreadyExists = bucket.some(
          (item) => item.id === artifact.id || (item.name === artifact.name && item.mime_type === artifact.mime_type),
        );
        if (!alreadyExists) {
          bucket.push(artifact);
        }
      }
      if (bucket.length > 0) {
        filesByMessage.set(lastAssistantMessage.id, bucket);
      }
    }
  }

  for (const row of messageRows) {
    const bucket = filesByMessage.get(row.id);
    if (bucket && bucket.length > 0) {
      row.attachments = sortPreviewableAttachments(bucket);
    }
  }

  const hydratedReasoning: Record<string, { text: string; startedAt: number; finishedAt: number | null }> = {};
  const tools: MabelToolEvent[] = (payload.tool_calls ?? []).flatMap((row) => {
    const turnId = runToTurn.get(row.run_id);
    if (row.tool_name === "mabel_reasoning") {
      if (turnId && row.output_preview) {
        const timestamp = new Date(row.created_at).getTime();
        const hydratedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
        hydratedReasoning[turnId] = {
          text: row.output_preview,
          startedAt: hydratedAt,
          finishedAt: hydratedAt,
        };
      }
      return [];
    }
    const events: MabelToolEvent[] = [];
    events.push({
      id: `tc-call-${row.id}`,
      type: "tool_call",
      tool_name: row.tool_name,
      detail: row.arguments ? JSON.stringify(row.arguments) : undefined,
      turn_id: turnId,
    });
    if (row.status === "approval_requested") {
      events.push({
        id: `tc-appr-${row.id}`,
        type: "approval_requested",
        tool_name: row.tool_name,
        detail: row.arguments ? JSON.stringify(row.arguments) : undefined,
        turn_id: turnId,
      });
    } else if (row.output_preview != null) {
      events.push({
        id: `tc-result-${row.id}`,
        type: "tool_result",
        tool_name: row.tool_name,
        detail: row.output_preview,
        turn_id: turnId,
      });
    }
    return events;
  });

  return {
    messageRows,
    tools,
    hydratedReasoning,
    projectId: payload.conversation.project_id || null,
    openContext: tools.length > 0 || Object.keys(hydratedReasoning).length > 0,
  };
}
