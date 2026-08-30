export type MabelSurface = "chat" | "rag" | "mcp" | "agents";

export type MabelSource = {
  url?: string;
  title?: string;
  provider?: string;
  kind?: "url" | "api" | "provider" | string;
};

export type MabelStreamEvent =
  | { type: "run_started"; run_id: string; conversation_id?: number }
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; tool_name: string; tool_call_id?: string; arguments?: Record<string, unknown> }
  | { type: "tool_result"; tool_name: string; tool_call_id?: string; output_preview?: string }
  | { type: "approval_requested"; tool_name: string; tool_call_id?: string; approval_id?: string; arguments?: Record<string, unknown> }
  | { type: "sources"; sources: MabelSource[] }
  | { type: "usage"; usage: Record<string, unknown> }
  | {
      type: "artifact_created";
      artifact_id: string;
      title: string;
      size_bytes?: number;
    }
  | { type: "error"; run_id?: string; message: string }
  | {
      type: "agent_file";
      file_id: string;
      name: string;
      mime: string;
      kind: "image" | "file";
      remote_only?: boolean;
    }
  | { type: "message_done"; run_id: string }
  | { type: "run_done"; run_id: string; status: string };

export type MabelMessageAttachment = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes?: number;
  /** Where it came from. user_upload = composer pick; agent_image/code_file = produced by the agent. */
  source: "user_upload" | "agent_image" | "agent_code_file" | string;
  /** When true, the file lives only on the remote provider (e.g. code interpreter container) and the backend can't yet serve raw bytes. */
  remote_only?: boolean;
};

export type MabelBootstrap = {
  user?: { email?: string; name?: string };
  surfaces: MabelSurface[];
  connectors: Array<{ id: string; name: string; connection_status: string; tool_count?: number; enabled?: boolean; description?: string }>;
  skills: Array<{
    id: string;
    name: string;
    status: string;
    owner_team?: string;
    current_version?: string;
    description?: string;
    created_at?: string;
    updated_at?: string;
    tags?: string[];
    mcp_bindings?: Array<{ server_slug?: string; connector_slug?: string; server?: string; connector?: string; tools?: string[] }>;
    score?: number;
    matched_fields?: string[];
    snippet?: string;
  }>;
  starter_packs: Array<{
    id: string;
    name: string;
    role_key?: string;
    status?: string;
    commands?: Array<{ name?: string; description?: string }>;
    skill_ids?: string[];
    connector_slugs?: string[];
    policies?: Record<string, unknown>;
  }>;
  approvals: Array<{
    id: string;
    title: string;
    summary?: string;
    requested_by?: string;
    status?: "pending" | "approved" | "rejected" | "dismissed" | string;
    created_at?: string;
    payload?: {
      tool_name?: string;
      scope?: string;
      server_slug?: string;
    };
  }>;
};

export type MabelScheduledTask = {
  id: string;
  name: string;
  prompt: string;
  schedule_kind: "cron" | "hourly" | "daily" | "weekly" | "morning" | "afternoon" | "evening" | string;
  cron: string;
  timezone: string;
  status: "active" | "paused" | "archived" | string;
  mode: "standalone" | "thread" | "workflow" | string;
  workflow_id?: string | null;
  notification_mode: "inbox" | "notify_on_change" | "silent" | string;
  last_run_at?: string | null;
  next_run_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type MabelScheduledRun = {
  id: string;
  task_id: string;
  status: string;
  summary: string;
  conversation_id?: number | null;
  workflow_run_id?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
};

export type MabelMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: MabelMessageAttachment[];
  sources?: MabelSource[];
  /** ISO timestamp, present on hydrated rows; absent on in-flight local
   *  rows (those use turnTimingByMessageId for their elapsed clock). */
  created_at?: string;
};

export type MabelToolEvent = {
  id: string;
  type: "tool_call" | "tool_result" | "approval_requested";
  tool_name: string;
  tool_call_id?: string;
  approval_id?: string;
  detail?: string;
  /**
   * Stable identifier for the conversational turn this event belongs to.
   * For live streams this is the assistantId being filled in by tokens.
   * For hydrated history it is the run_id from the backend. The thread
   * uses this to anchor a tool cluster to a specific assistant turn so
   * later turns don't visually drag earlier tool calls down with them.
   */
  turn_id?: string;
};

export type MabelConversationSummary = {
  id: number;
  title: string;
  surface: MabelSurface;
  project_id?: string | null;
  project_name?: string | null;
  message_count: number;
  updated_at: string;
  /** Stable client-side id used as the React key. Survives optimistic→confirmed id promotion. */
  client_key?: string;
};

export type MabelPersistedToolCall = {
  id: number;
  run_id: string;
  tool_name: string;
  status: string;
  arguments?: Record<string, unknown> | null;
  output_preview?: string | null;
  created_at: string;
};

export type MabelConversationFile = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  source: string;
  run_id: string | null;
  created_at: string;
};

export type MabelConversationMessages = {
  conversation: {
    id: number;
    title: string;
    surface: MabelSurface;
    project_id?: string | null;
    project_name?: string | null;
    updated_at: string;
  };
  messages: Array<{
    id: number;
    role: "user" | "assistant" | "system";
    content: string;
    created_at: string;
    sources?: MabelSource[];
    run_id?: string | null;
  }>;
  tool_calls?: MabelPersistedToolCall[];
  files?: MabelConversationFile[];
};

export type MabelDocument = {
  id: string;
  title: string;
  kind: "markdown" | "html" | "dashboard" | "csv" | "text";
  content: string;
  conversation_id: number | null;
  created_at: string;
  updated_at: string;
};

export type MabelProject = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  color: "slate" | "blue" | "green" | "amber" | "rose" | "violet";
  conversation_count: number;
  file_count: number;
  created_at: string;
  updated_at: string;
};

export type MabelUploadedFile = {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  openai_file_id: string | null;
  source: string;
  conversation_id: number | null;
  project_id: string | null;
  run_id?: string | null;
  created_at: string;
};

export type MabelProjectDetail = {
  project: MabelProject;
  conversations: MabelConversationSummary[];
  files: MabelUploadedFile[];
};

export type MabelMemoryItem = {
  id: string;
  key: string;
  content: string;
  tags: string[];
  pinned: boolean;
  confidence: number;
  source: string;
  conversation_id: number | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MabelMemoryExportItem = {
  key: string;
  content: string;
  tags: string[];
  pinned: boolean;
  confidence: number;
  source: string;
  conversation_id: number | null;
  created_at: string;
  updated_at: string;
};

export type MabelMemoryExport = {
  version: string;
  count: number;
  items: MabelMemoryExportItem[];
};

export type MabelMemoryImportResult = {
  status: string;
  mode: "upsert" | "replace";
  created: number;
  updated: number;
  skipped: number;
  imported_ids: string[];
};

export type MabelAdminLogs = {
  scope?: "admin" | string;
  admin?: { email?: string };
  period?: { days?: number; since?: string | null };
  store?: { status?: string; store?: string };
  totals?: {
    requests?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
    conversations?: number;
    tool_calls?: number;
    users?: number;
  };
  breakdowns?: {
    by_user?: Array<{ user_email: string; requests: number; total_tokens: number; cost_usd?: number; last_seen_at?: string | null }>;
    by_surface?: Array<{ surface: string; requests: number }>;
    by_status?: Array<{ status: string; requests: number }>;
    by_model?: Array<{ model: string; requests: number; total_tokens: number; cost_usd?: number }>;
    daily?: Array<{ date: string; requests: number; cost_usd?: number }>;
  };
  recent?: {
    usage?: Array<Record<string, unknown>>;
    runs?: Array<Record<string, unknown>>;
    tool_calls?: Array<{
      id?: number | null;
      run_id: string;
      tool_name: string;
      status: string;
      server_slug?: string | null;
      scope?: string;
      output_preview?: string | null;
      created_at?: string | null;
    }>;
    audit_events?: Array<{ id?: number | null; actor_email: string; event_type: string; status: string; created_at?: string | null }>;
  };
  counts?: { runs?: number; usage_events?: number; tool_calls?: number; audit_events?: number };
};
