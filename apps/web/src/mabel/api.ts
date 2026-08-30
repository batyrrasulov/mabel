import type {
  MabelAdminLogs,
  MabelBootstrap,
  MabelConversationMessages,
  MabelConversationSummary,
  MabelDocument,
  MabelMemoryExport,
  MabelMemoryImportResult,
  MabelMemoryItem,
  MabelProject,
  MabelProjectDetail,
  MabelScheduledRun,
  MabelScheduledTask,
  MabelStreamEvent,
  MabelSurface,
  MabelUploadedFile,
} from "./types";
import { getAuthHeaders } from "@/lib/auth";

export const DEFAULT_MABEL_API_PREFIX =
  (import.meta.env.VITE_MABEL_API_PREFIX as string | undefined)?.trim() || "/mabel-api";

export function mabelApiUrl(path: string, base = DEFAULT_MABEL_API_PREFIX): string {
  const normalizedBase = base.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/** Build a same-origin URL to fetch (download or render inline) a Mabel file. */
export function mabelFileUrl(fileId: string, base = DEFAULT_MABEL_API_PREFIX): string {
  return mabelApiUrl(`/api/v1/files/${encodeURIComponent(fileId)}`, base);
}

export function mabelFilePreviewUrl(fileId: string, base = DEFAULT_MABEL_API_PREFIX): string {
  return mabelApiUrl(`/api/v1/files/${encodeURIComponent(fileId)}/preview`, base);
}

export function mabelFilePreviewPdfUrl(fileId: string, base = DEFAULT_MABEL_API_PREFIX): string {
  return mabelApiUrl(`/api/v1/files/${encodeURIComponent(fileId)}/preview/pdf`, base);
}

export function parseMabelSseFrames(text: string): MabelStreamEvent[] {
  const events: MabelStreamEvent[] = [];
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data) as MabelStreamEvent);
  }
  return events;
}

export async function getMabelBootstrap(base = DEFAULT_MABEL_API_PREFIX): Promise<MabelBootstrap> {
  const response = await fetch(mabelApiUrl("/api/v1/bootstrap", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Mabel bootstrap failed: ${response.status}`);
  }
  return response.json() as Promise<MabelBootstrap>;
}

export async function getMabelConversations(base = DEFAULT_MABEL_API_PREFIX): Promise<MabelConversationSummary[]> {
  const response = await fetch(mabelApiUrl("/api/v1/conversations", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Mabel conversations failed: ${response.status}`);
  }
  const payload = (await response.json()) as { conversations?: MabelConversationSummary[] };
  return payload.conversations || [];
}

export async function getMabelConversationMessages(
  conversationId: number,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelConversationMessages> {
  const response = await fetch(mabelApiUrl(`/api/v1/conversations/${conversationId}/messages`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Mabel conversation load failed: ${response.status}`);
  }
  return response.json() as Promise<MabelConversationMessages>;
}

export async function createMabelSkill(
  payload: {
    id: string;
    name: string;
    owner_team: string;
    content_md: string;
    description?: string;
    tags?: string[];
    mcp_bindings?: Array<Record<string, unknown>>;
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<unknown> {
  const response = await fetch(mabelApiUrl("/api/v1/skills", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: payload.id,
      name: payload.name,
      owner_team: payload.owner_team,
      content_md: payload.content_md,
      description: payload.description,
      tags: payload.tags || [],
      mcp_bindings: payload.mcp_bindings || [],
    }),
  });
  if (!response.ok) {
    throw new Error(`Skill create failed: ${response.status}`);
  }
  return response.json();
}

export async function getMabelSkills(
  query?: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelBootstrap["skills"]> {
  const suffix = query?.trim() ? `?query=${encodeURIComponent(query.trim())}` : "";
  const response = await fetch(mabelApiUrl(`/api/v1/skills${suffix}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Skills list failed: ${response.status}`);
  }
  const payload = (await response.json()) as { skills?: MabelBootstrap["skills"] };
  return payload.skills || [];
}

export async function getMabelSkill(
  skillId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ skill?: { id: string; name: string; owner_team: string; content_md?: string; tags?: string[]; mcp_bindings?: Array<Record<string, unknown>>; status?: string; description?: string; created_at?: string; updated_at?: string } }> {
  const response = await fetch(mabelApiUrl(`/api/v1/skills/${encodeURIComponent(skillId)}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Skill load failed: ${response.status}`);
  }
  return response.json();
}

export type MabelSkillMarketplace = {
  status?: string;
  repo?: string;
  ref?: string;
  base_path?: string;
  token_configured?: boolean;
  error?: string;
  skills?: Array<{
    id: string;
    name: string;
    owner_team?: string;
    status?: string;
    current_version?: string;
    tags?: string[];
    mcp_bindings?: Array<Record<string, unknown>>;
    source?: Record<string, unknown>;
    description?: string;
  }>;
};

export async function getMabelSkillMarketplace(base = DEFAULT_MABEL_API_PREFIX): Promise<MabelSkillMarketplace> {
  const response = await fetch(mabelApiUrl("/api/v1/skills/marketplace", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Skill marketplace failed: ${response.status}`);
  }
  return response.json();
}

export async function syncMabelSkillMarketplace(base = DEFAULT_MABEL_API_PREFIX): Promise<{ status?: string; synced?: Array<{ id: string; name: string }> }> {
  const response = await fetch(mabelApiUrl("/api/v1/skills/sync", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`Skill marketplace sync failed: ${response.status}`);
  }
  return response.json();
}

export async function shareMabelSkill(
  skillId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ status?: string; share?: { branch?: string; compare_url?: string }; skill?: { status?: string } }> {
  const response = await fetch(mabelApiUrl(`/api/v1/skills/${encodeURIComponent(skillId)}/share`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ visibility: "org" }),
  });
  if (!response.ok) {
    throw new Error(`Skill share failed: ${response.status}`);
  }
  return response.json();
}

export async function runMabelSkill(
  skillId: string,
  prompt: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ status?: string; assistant_text?: string }> {
  const response = await fetch(mabelApiUrl(`/api/v1/skills/${encodeURIComponent(skillId)}/run`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    throw new Error(`Skill run failed: ${response.status}`);
  }
  return response.json();
}

export async function listMcpTools(
  serverSlug: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ tools: unknown[]; source?: string; server_slug?: string }> {
  const response = await fetch(mabelApiUrl(`/api/v1/mcp/${encodeURIComponent(serverSlug)}/tools/list`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      const rawDetail = payload?.detail;
      if (typeof rawDetail === "string") {
        detail = rawDetail;
      } else if (rawDetail) {
        detail = JSON.stringify(rawDetail);
      }
    } catch {
      detail = "";
    }
    throw new Error(`MCP list tools failed: ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return response.json();
}

export async function syncMcpConnectors(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ status?: string; count?: number; connectors?: Array<{ server_slug: string; status: string; source?: string; reason?: string; tool_count?: number }> }> {
  const response = await fetch(mabelApiUrl("/api/v1/mcp/sync", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      const rawDetail = payload?.detail;
      if (typeof rawDetail === "string") {
        detail = rawDetail;
      } else if (rawDetail) {
        detail = JSON.stringify(rawDetail);
      }
    } catch {
      detail = "";
    }
    throw new Error(`MCP sync failed: ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return response.json();
}

export async function callMcpTool(
  serverSlug: string,
  toolName: string,
  args: Record<string, unknown>,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<unknown> {
  const response = await fetch(mabelApiUrl(`/api/v1/mcp/${encodeURIComponent(serverSlug)}/tools/call`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: toolName, arguments: args }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      const rawDetail = payload?.detail;
      if (typeof rawDetail === "string") {
        detail = rawDetail;
      } else if (rawDetail) {
        detail = JSON.stringify(rawDetail);
      }
    } catch {
      detail = "";
    }
    throw new Error(`MCP call failed: ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return response.json();
}

export async function updateMabelSkill(
  skillId: string,
  payload: {
    name?: string;
    owner_team?: string;
    content_md?: string;
    description?: string;
    tags?: string[];
    mcp_bindings?: Array<Record<string, unknown>>;
    status?: "draft" | "review" | "published" | "archived";
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<unknown> {
  const response = await fetch(mabelApiUrl(`/api/v1/skills/${encodeURIComponent(skillId)}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Skill update failed: ${response.status}`);
  }
  return response.json();
}

export async function deleteMabelSkill(skillId: string, base = DEFAULT_MABEL_API_PREFIX): Promise<void> {
  const response = await fetch(mabelApiUrl(`/api/v1/skills/${encodeURIComponent(skillId)}`, base), {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Skill delete failed: ${response.status}`);
  }
}

export async function setConnectorEnabled(
  serverSlug: string,
  enabled: boolean,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<unknown> {
  const response = await fetch(mabelApiUrl(`/api/v1/mcp/${encodeURIComponent(serverSlug)}/state`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(`Connector state failed: ${response.status}`);
  }
  return response.json();
}

export async function getConnectorReadiness(
  serverSlug: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{
  connector?: { name?: string; enabled?: boolean | null; connection_status?: string; tool_count?: number };
  endpoint_candidates?: Array<{ transport: string; configured: boolean; endpoint: string }>;
  approval_required_count?: number;
  tool_policy?: Array<{ name: string; scope: string; decision: "allow" | "ask" | "deny"; requires_approval: boolean }>;
  recommendations?: string[];
}> {
  const response = await fetch(mabelApiUrl(`/api/v1/mcp/${encodeURIComponent(serverSlug)}/readiness`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Connector readiness failed: ${response.status}`);
  }
  return response.json();
}

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "rejected" | "dismissed",
  reason?: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<unknown> {
  const response = await fetch(mabelApiUrl(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ decision, reason: reason || null }),
  });
  if (!response.ok) {
    throw new Error(`Approval decision failed: ${response.status}`);
  }
  return response.json();
}

export async function renameMabelConversation(
  conversationId: number,
  title: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<unknown> {
  const response = await fetch(mabelApiUrl(`/api/v1/conversations/${conversationId}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(`Conversation rename failed: ${response.status}`);
  }
  return response.json();
}

export async function deleteMabelConversation(
  conversationId: number,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<void> {
  const response = await fetch(mabelApiUrl(`/api/v1/conversations/${conversationId}`, base), {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Conversation delete failed: ${response.status}`);
  }
}

export async function getMabelProjects(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelProject[]> {
  const response = await fetch(mabelApiUrl("/api/v1/projects", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Projects list failed: ${response.status}`);
  const payload = (await response.json()) as { projects?: MabelProject[] };
  return payload.projects || [];
}

export async function getMabelProject(
  projectId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelProjectDetail> {
  const response = await fetch(mabelApiUrl(`/api/v1/projects/${encodeURIComponent(projectId)}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Project load failed: ${response.status}`);
  return response.json() as Promise<MabelProjectDetail>;
}

export async function createMabelProject(
  payload: Pick<MabelProject, "name"> & Partial<Pick<MabelProject, "description" | "instructions" | "color">>,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelProject> {
  const response = await fetch(mabelApiUrl("/api/v1/projects", base), {
    method: "POST",
    credentials: "include",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Project create failed: ${response.status}`);
  const json = (await response.json()) as { project: MabelProject };
  return json.project;
}

export async function updateMabelProject(
  projectId: string,
  payload: Partial<Pick<MabelProject, "name" | "description" | "instructions" | "color">>,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelProject> {
  const response = await fetch(mabelApiUrl(`/api/v1/projects/${encodeURIComponent(projectId)}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Project update failed: ${response.status}`);
  const json = (await response.json()) as { project: MabelProject };
  return json.project;
}

export async function deleteMabelProject(
  projectId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ deleted: string; retained_conversations: number; retained_files: number }> {
  const response = await fetch(mabelApiUrl(`/api/v1/projects/${encodeURIComponent(projectId)}`, base), {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Project delete failed: ${response.status}`);
  return response.json();
}

export async function moveMabelConversationToProject(
  conversationId: number,
  projectId: string | null,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelConversationSummary> {
  const response = await fetch(mabelApiUrl(`/api/v1/conversations/${conversationId}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!response.ok) throw new Error(`Conversation move failed: ${response.status}`);
  const json = (await response.json()) as { conversation: MabelConversationSummary };
  return json.conversation;
}

export type MabelStartMyDayBrief = {
  time: string;
  account_name: string;
  attendees: string[];
  sources_used: string[];
  sections: Record<string, string>;
};

export type MabelStartMyDayResponse = {
  status?: string;
  date?: string;
  briefs?: MabelStartMyDayBrief[];
  controlled_actions?: Array<{ name: string; scope: string; requires_approval: boolean }>;
  missing_connectors?: string[];
  missing_skills?: string[];
};

export async function runStartMyDay(
  payload: {
    date: string;
    meetings: Array<{ time: string; account_name: string; attendees: string[]; signals: Array<{ source: string; text: string }> }>;
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelStartMyDayResponse> {
  const response = await fetch(mabelApiUrl("/api/v1/starter-packs/account-manager/start-my-day", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Starter pack run failed: ${response.status}`);
  }
  return response.json() as Promise<MabelStartMyDayResponse>;
}

export type MabelWorkflowCheckpoint = {
  id: string;
  title: string;
  status: string;
  description: string;
  requires_approval?: boolean;
};

export type MabelWorkflowPlanStep = {
  id: string;
  title: string;
  command: string;
  objective: string;
  status: string;
  skill_ids: string[];
  connector_slugs: string[];
  uses_chat_runtime: boolean;
  approval_gate?: {
    required_for_scopes?: string[];
    status?: string;
  };
  retry_policy?: {
    max_attempts?: number;
    fallback?: string;
  };
  result?: {
    status?: string;
    summary?: string;
  };
};

export type MabelWorkflowExecutionPlan = {
  mode: string;
  objective: string;
  schedule?: {
    type?: string;
    cadence?: string | null;
    description?: string;
    unattended_until_approval?: boolean;
  };
  steps: MabelWorkflowPlanStep[];
  fallback_paths?: string[];
  observability?: {
    step_logs?: boolean;
    run_resume?: boolean;
    checkpoint_visibility?: boolean;
  };
};

export type MabelWorkflowRunResponse = {
  run_id: string;
  status: string;
  objective: string;
  starter_pack?: {
    id: string;
    name: string;
    role_key?: string;
  };
  checkpoints: MabelWorkflowCheckpoint[];
  missing_connectors?: string[];
  missing_skills?: string[];
  outputs?: {
    briefs?: MabelStartMyDayBrief[];
    draft_actions?: Array<Record<string, unknown>>;
    step_results?: Array<Record<string, unknown>>;
    execution_plan?: MabelWorkflowExecutionPlan;
    observability?: {
      run_id?: string;
      status?: string;
      events?: Array<{ type?: string; status?: string; timestamp?: string; message?: string }>;
      live_logs_available?: boolean;
    };
    next_actions?: Array<{ kind?: string; label?: string; prompt?: string; run_id?: string }>;
    [key: string]: unknown;
  };
};

export async function runMabelWorkflow(
  starterPackId: string,
  payload: {
    objective: string;
    dry_run?: boolean;
    date?: string;
    meetings?: Array<{ time: string; account_name: string; attendees: string[]; signals: Array<{ source: string; text: string }> }>;
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelWorkflowRunResponse> {
  const response = await fetch(mabelApiUrl(`/api/v1/workflows/${encodeURIComponent(starterPackId)}/run`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Workflow run failed: ${response.status}`);
  }
  return response.json();
}

export async function resumeMabelWorkflowRun(
  runId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ status: string; run_id: string; resumed_checkpoint?: MabelWorkflowCheckpoint; state_json?: Record<string, unknown> }> {
  const response = await fetch(mabelApiUrl(`/api/v1/workflows/runs/${encodeURIComponent(runId)}/resume`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`Workflow resume failed: ${response.status}`);
  }
  return response.json();
}

export async function createMabelWorkflowPack(
  payload: {
    name: string;
    objective: string;
    role_key?: string;
    skill_ids?: string[];
    connector_slugs?: string[];
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{
  starter_pack: {
    id: string;
    name: string;
    role_key: string;
    status: string;
    commands: Array<{ name?: string; description?: string }>;
    skill_ids: string[];
    connector_slugs: string[];
    owner_team?: string;
    policies?: Record<string, unknown>;
  };
}> {
  const response = await fetch(mabelApiUrl("/api/v1/workflows", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Workflow create failed: ${response.status}`);
  }
  return response.json();
}

export async function getMabelScheduled(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ tasks: MabelScheduledTask[]; runs: MabelScheduledRun[] }> {
  const response = await fetch(mabelApiUrl("/api/v1/scheduled", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Scheduled list failed: ${response.status}`);
  }
  const payload = (await response.json()) as { tasks?: MabelScheduledTask[]; runs?: MabelScheduledRun[] };
  return { tasks: payload.tasks || [], runs: payload.runs || [] };
}

export async function createMabelScheduledTask(
  payload: {
    name: string;
    prompt: string;
    schedule_kind: MabelScheduledTask["schedule_kind"];
    cron?: string | null;
    timezone?: string;
    mode?: MabelScheduledTask["mode"];
    workflow_id?: string | null;
    notification_mode?: MabelScheduledTask["notification_mode"];
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelScheduledTask> {
  const response = await fetch(mabelApiUrl("/api/v1/scheduled", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Scheduled create failed: ${response.status}`);
  }
  const json = (await response.json()) as { task: MabelScheduledTask };
  return json.task;
}

export async function updateMabelScheduledTask(
  taskId: string,
  payload: Partial<Pick<MabelScheduledTask, "name" | "prompt" | "schedule_kind" | "cron" | "timezone" | "status" | "mode" | "workflow_id" | "notification_mode">>,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelScheduledTask> {
  const response = await fetch(mabelApiUrl(`/api/v1/scheduled/${encodeURIComponent(taskId)}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Scheduled update failed: ${response.status}`);
  }
  const json = (await response.json()) as { task: MabelScheduledTask };
  return json.task;
}

export async function runMabelScheduledTask(
  taskId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ task: MabelScheduledTask; run: MabelScheduledRun }> {
  const response = await fetch(mabelApiUrl(`/api/v1/scheduled/${encodeURIComponent(taskId)}/run`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`Scheduled run failed: ${response.status}`);
  }
  return response.json() as Promise<{ task: MabelScheduledTask; run: MabelScheduledRun }>;
}

export async function getMabelUsageSummary(
  params: { days?: number } = {},
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{
  scope?: string;
  days?: number;
  totals?: { requests?: number; input_tokens?: number; output_tokens?: number; total_tokens?: number };
  leaderboard?: Array<{ user_email: string; requests: number; total_tokens: number }>;
  runs?: Array<Record<string, unknown>>;
}> {
  const query = new URLSearchParams();
  if (params.days) query.set("days", String(params.days));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await fetch(mabelApiUrl(`/api/v1/usage/summary${suffix}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Usage summary failed: ${response.status}`);
  }
  return response.json();
}

export async function getMabelAdminAccess(base = DEFAULT_MABEL_API_PREFIX): Promise<{ is_admin: boolean }> {
  const response = await fetch(mabelApiUrl("/api/v1/admin/check-access", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Mabel admin access failed: ${response.status}`);
  }
  return response.json();
}

export async function getMabelAdminLogs(
  params: { days?: number; limit?: number } = {},
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelAdminLogs> {
  const query = new URLSearchParams();
  if (params.days) query.set("days", String(params.days));
  if (params.limit) query.set("limit", String(params.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await fetch(mabelApiUrl(`/api/v1/admin/logs${suffix}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Mabel admin logs failed: ${response.status}`);
  }
  return response.json();
}

export async function getMabelNormalizationHealth(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{
  store?: string;
  strict_reads?: boolean;
  ready_for_strict_reads?: boolean;
  backfill_gap?: Record<string, number>;
}> {
  const response = await fetch(mabelApiUrl("/api/v1/health/normalization", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Normalization health failed: ${response.status}`);
  }
  return response.json();
}

export async function getMabelDocuments(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelDocument[]> {
  const response = await fetch(mabelApiUrl("/api/v1/documents", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Documents list failed: ${response.status}`);
  }
  const payload = (await response.json()) as { documents?: MabelDocument[] };
  return payload.documents || [];
}

export async function getMabelArtifacts(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelDocument[]> {
  const response = await fetch(mabelApiUrl("/api/v1/artifacts", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Artifacts list failed: ${response.status}`);
  }
  const payload = (await response.json()) as { artifacts?: MabelDocument[] };
  return payload.artifacts || [];
}

export async function createMabelDocument(
  payload: {
    title: string;
    kind: MabelDocument["kind"];
    content: string;
    conversation_id?: number | null;
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelDocument> {
  const response = await fetch(mabelApiUrl("/api/v1/documents", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Document create failed: ${response.status}`);
  }
  const json = (await response.json()) as { document: MabelDocument };
  return json.document;
}

export async function getMabelArtifact(
  documentId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelDocument> {
  const response = await fetch(mabelApiUrl(`/api/v1/artifacts/${encodeURIComponent(documentId)}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Artifact fetch failed: ${response.status}`);
  }
  const json = (await response.json()) as { artifact: MabelDocument };
  return json.artifact;
}

export async function createMabelArtifact(
  payload: {
    title: string;
    kind: MabelDocument["kind"];
    content: string;
    conversation_id?: number | null;
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelDocument> {
  const response = await fetch(mabelApiUrl("/api/v1/artifacts", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Artifact create failed: ${response.status}`);
  }
  const json = (await response.json()) as { artifact: MabelDocument };
  return json.artifact;
}

export async function updateMabelDocument(
  documentId: string,
  payload: Partial<Pick<MabelDocument, "title" | "kind" | "content" | "conversation_id">>,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelDocument> {
  const response = await fetch(mabelApiUrl(`/api/v1/documents/${encodeURIComponent(documentId)}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Document update failed: ${response.status}`);
  }
  const json = (await response.json()) as { document: MabelDocument };
  return json.document;
}

export async function updateMabelArtifact(
  documentId: string,
  payload: Partial<Pick<MabelDocument, "title" | "kind" | "content" | "conversation_id">>,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelDocument> {
  const response = await fetch(mabelApiUrl(`/api/v1/artifacts/${encodeURIComponent(documentId)}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Artifact update failed: ${response.status}`);
  }
  const json = (await response.json()) as { artifact: MabelDocument };
  return json.artifact;
}

export async function deleteMabelDocument(
  documentId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<void> {
  const response = await fetch(mabelApiUrl(`/api/v1/documents/${encodeURIComponent(documentId)}`, base), {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Document delete failed: ${response.status}`);
  }
}

export async function deleteMabelArtifact(
  documentId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<void> {
  const response = await fetch(mabelApiUrl(`/api/v1/artifacts/${encodeURIComponent(documentId)}`, base), {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Artifact delete failed: ${response.status}`);
  }
}

export async function getMabelMemory(
  query?: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelMemoryItem[]> {
  const suffix = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const response = await fetch(mabelApiUrl(`/api/v1/memory${suffix}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Memory list failed: ${response.status}`);
  }
  const payload = (await response.json()) as { memory?: MabelMemoryItem[] };
  return payload.memory || [];
}

export async function createMabelMemory(
  payload: {
    key: string;
    content: string;
    tags?: string[];
    pinned?: boolean;
    confidence?: number;
    source?: string;
    conversation_id?: number | null;
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelMemoryItem> {
  const response = await fetch(mabelApiUrl("/api/v1/memory", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Memory create failed: ${response.status}`);
  }
  const json = (await response.json()) as { item: MabelMemoryItem };
  return json.item;
}

export async function updateMabelMemory(
  itemId: string,
  payload: Partial<Pick<MabelMemoryItem, "key" | "content" | "tags" | "pinned" | "confidence" | "source" | "conversation_id">>,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelMemoryItem> {
  const response = await fetch(mabelApiUrl(`/api/v1/memory/${encodeURIComponent(itemId)}`, base), {
    method: "PATCH",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Memory update failed: ${response.status}`);
  }
  const json = (await response.json()) as { item: MabelMemoryItem };
  return json.item;
}

export async function deleteMabelMemory(
  itemId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<void> {
  const response = await fetch(mabelApiUrl(`/api/v1/memory/${encodeURIComponent(itemId)}`, base), {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Memory delete failed: ${response.status}`);
  }
}

export async function exportMabelMemory(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelMemoryExport> {
  const response = await fetch(mabelApiUrl("/api/v1/memory/export", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Memory export failed: ${response.status}`);
  }
  return response.json() as Promise<MabelMemoryExport>;
}

export async function importMabelMemory(
  payload: {
    mode?: "upsert" | "replace";
    items: Array<{
      key: string;
      content: string;
      tags?: string[];
      pinned?: boolean;
      confidence?: number;
      source?: string;
      conversation_id?: number | null;
    }>;
  },
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelMemoryImportResult> {
  const response = await fetch(mabelApiUrl("/api/v1/memory/import", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Memory import failed: ${response.status}`);
  }
  return response.json() as Promise<MabelMemoryImportResult>;
}

export async function uploadMabelFiles(
  files: File[],
  options: { conversationId?: number; projectId?: string; base?: string; signal?: AbortSignal } = {},
): Promise<MabelUploadedFile[]> {
  if (files.length === 0) return [];
  const base = options.base || DEFAULT_MABEL_API_PREFIX;
  const query = new URLSearchParams();
  if (options.conversationId) query.set("conversation_id", String(options.conversationId));
  if (options.projectId) query.set("project_id", options.projectId);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const url = mabelApiUrl(`/api/v1/uploads${suffix}`, base);
  const form = new FormData();
  for (const file of files) {
    form.append("files", file, file.name);
  }
  // CRITICAL: getAuthHeaders() defaults to {"Content-Type": "application/json"}.
  // For multipart uploads we MUST drop that — the browser auto-sets
  // `Content-Type: multipart/form-data; boundary=...`. If we leave
  // application/json on, FastAPI's UploadFile parser fails and the whole
  // request 422s before any byte of the file is read.
  const { "Content-Type": _drop, ...authHeaders } = getAuthHeaders();
  void _drop;
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: authHeaders,
    body: form,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
  const json = (await response.json()) as { files?: MabelUploadedFile[] };
  return json.files ?? [];
}

export async function getMabelFiles(
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<MabelUploadedFile[]> {
  const response = await fetch(mabelApiUrl("/api/v1/files", base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Files list failed: ${response.status}`);
  const payload = (await response.json()) as { files?: MabelUploadedFile[] };
  return payload.files || [];
}

export async function deleteMabelFile(
  fileId: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<void> {
  const response = await fetch(mabelApiUrl(`/api/v1/files/${encodeURIComponent(fileId)}`, base), {
    method: "DELETE",
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`File delete failed: ${response.status}`);
}

export async function consumeMabelSseResponse(
  response: Response,
  onEvent: (event: MabelStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`Mabel stream failed: ${response.status}`);
  }
  if (!response.body) {
    parseMabelSseFrames(await response.text()).forEach(onEvent);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  };
  signal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        const normalized = buffer.replace(/\r\n/g, "\n");
        const parts = normalized.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          parseMabelSseFrames(`${part}\n\n`).forEach(onEvent);
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      parseMabelSseFrames(`${buffer}\n\n`).forEach(onEvent);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function runStartMyDayDemoStream(
  onEvent: (event: MabelStreamEvent) => void,
  options: { signal?: AbortSignal; base?: string } = {},
): Promise<void> {
  const base = options.base || DEFAULT_MABEL_API_PREFIX;
  const response = await fetch(mabelApiUrl("/api/v1/workflows/workflow-pack.start-my-day/demo-stream", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      Accept: "text/event-stream",
    },
    signal: options.signal,
  });
  await consumeMabelSseResponse(response, onEvent, options.signal);
}

export async function sendMabelMessage(
  message: string,
  surface: MabelSurface,
  onEvent: (event: MabelStreamEvent) => void,
  conversationId?: number,
  options: {
    signal?: AbortSignal;
    base?: string;
    instructions?: string;
    attachments?: Array<{ id: string }>;
    documents?: Array<{ id: string }>;
    projectId?: string;
  } = {},
): Promise<void> {
  const base = options.base || DEFAULT_MABEL_API_PREFIX;
  const response = await fetch(mabelApiUrl("/api/v1/chat/stream", base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      message,
      surface,
      conversation_id: conversationId,
      project_id: options.projectId || undefined,
      instructions: options.instructions || undefined,
      attachments: options.attachments && options.attachments.length > 0 ? options.attachments : undefined,
      documents: options.documents && options.documents.length > 0 ? options.documents : undefined,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Mabel chat failed: ${response.status}`);
  }

  await consumeMabelSseResponse(response, onEvent, options.signal);
}

export async function getMabelRun(runId: string, base = DEFAULT_MABEL_API_PREFIX): Promise<{
  run?: {
    id: string;
    conversation_id?: number | null;
    surface?: string;
    status?: string;
    model?: string;
    state_json?: Record<string, unknown>;
    created_at?: string;
    finished_at?: string | null;
  };
}> {
  const response = await fetch(mabelApiUrl(`/api/v1/runs/${encodeURIComponent(runId)}`, base), {
    credentials: "include",
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`Run status failed: ${response.status}`);
  return response.json();
}

export async function stopMabelRun(runId: string, base = DEFAULT_MABEL_API_PREFIX): Promise<{ status?: string }> {
  const response = await fetch(mabelApiUrl(`/api/v1/runs/${encodeURIComponent(runId)}/stop`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Run stop failed: ${response.status}`);
  return response.json();
}

export async function resumeMabelRun(
  runId: string,
  prompt?: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ status?: string; resume_prompt?: string; conversation_id?: number; surface?: string }> {
  const response = await fetch(mabelApiUrl(`/api/v1/runs/${encodeURIComponent(runId)}/resume`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error(`Run resume failed: ${response.status}`);
  return response.json();
}

export async function enqueueMabelRunPrompt(
  runId: string,
  mode: "steer" | "queue",
  prompt: string,
  base = DEFAULT_MABEL_API_PREFIX,
): Promise<{ item?: { id: string; mode: string; prompt: string; status: string } }> {
  const response = await fetch(mabelApiUrl(`/api/v1/runs/${encodeURIComponent(runId)}/inbox`, base), {
    method: "POST",
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode, prompt }),
  });
  if (!response.ok) throw new Error(`Prompt inbox enqueue failed: ${response.status}`);
  return response.json();
}
