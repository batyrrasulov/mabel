import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

let __conversationsReqId = 0;
let __bootstrapReqId = 0;
let __projectsReqId = 0;
const OPTIMISTIC_CONVERSATION_ID = -1;
const START_MY_DAY_WORKFLOW_ID = "workflow-pack.start-my-day";
const BUILD_WORKFLOW_VISIBLE_PROMPT = "Help me build a Mabel workflow.";
const BUILD_WORKFLOW_HIDDEN_INSTRUCTIONS =
  "Explain Mabel workflows in one concise paragraph. Interview the user for the workflow objective, required skills, MCP connectors, and success criteria. After the user answers, call mabel_build_execution_plan, then mabel_create_workflow with the final name, objective, selected skill IDs, and connector slugs. Do not use dummy placeholders; choose from Mabel context.";

import {
  deleteMabelConversation,
  deleteMabelMemory,
  exportMabelMemory,
  getMabelArtifact,
  getMabelArtifacts,
  getMabelAdminAccess,
  getMabelAdminLogs,
  getMabelBootstrap,
  getMabelConversationMessages,
  getMabelConversations,
  getMabelFiles,
  getMabelMemory,
  getMabelProjects,
  getMabelScheduled,
  getMabelSkills,
  getMabelUsageSummary,
  renameMabelConversation,
  runMabelWorkflow,
} from "./api";
import { fetchMabelCached, getMabelCached, invalidateMabelCache, mabelCacheKey, MABEL_LOGS_PAGE_LIMIT, mabelLogsCacheKey, mabelConversationCacheKey, setMabelCached } from "./sessionCache";
import { hydrateConversationPayload } from "./conversationHydration";
import { ActivityPanel } from "./components/ActivityPanel";
import { ArtifactPanel, type MabelArtifact } from "./components/ArtifactPanel";
import { ArtifactsPage } from "./components/ArtifactsPage";
import { BrandMark } from "./components/BrandMark";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectorsPage } from "./components/ConnectorsPage";
import { HistoryItem } from "./components/HistoryItem";
import { LibraryPage } from "./components/LibraryPage";
import { LogsPage } from "./components/LogsPage";
import { MemoryPage } from "./components/MemoryPage";
import { Markdown, type MarkdownArtifact } from "./components/Markdown";
import { MessageAttachments } from "./components/MessageAttachments";
import { PromptComposer, type AttachedFile, type SlashAction } from "./components/PromptComposer";
import { ProjectsPage } from "./components/ProjectsPage";
import { MabelFilePreviewPanel } from "./components/MabelFilePreviewPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ScheduledPage } from "./components/ScheduledPage";
import { SkillsPage } from "./components/SkillsPage";
import { UsagePage } from "./components/UsagePage";
import { MessageSteps } from "./components/MessageSteps";
import { WelcomePane } from "./components/WelcomePane";
import { WorkflowsPage } from "./components/WorkflowsPage";
import { ProjectsNavIcon, LibraryNavIcon } from "./icons/nav-icons";
import { mabelUiEnabledConnectors } from "./connectorUi";
import { useMabelStream } from "./hooks/useMabelStream";
import { useUsageTracker, type UsageKind } from "./hooks/useUsageTracker";
import { getCurrentUser } from "@/lib/auth";
import type {
  MabelBootstrap,
  MabelConversationMessages,
  MabelConversationSummary,
  MabelMemoryItem,
  MabelMessage,
  MabelMessageAttachment,
  MabelProject,
  MabelToolEvent,
  MabelUploadedFile,
} from "./types";

import "./mabel.css";

const EMPTY_BOOTSTRAP: MabelBootstrap = {
  surfaces: ["chat", "rag", "mcp", "agents"],
  connectors: [],
  skills: [],
  starter_packs: [],
  approvals: [],
};

type MabelView =
  | "chat"
  | "projects"
  | "library"
  | "memory"
  | "connectors"
  | "skills"
  | "workflows"
  | "artifacts"
  | "scheduled"
  | "usage"
  | "logs";

const MABEL_VIEWS = new Set<MabelView>([
  "chat",
  "projects",
  "library",
  "memory",
  "connectors",
  "skills",
  "workflows",
  "artifacts",
  "scheduled",
  "usage",
  "logs",
]);

type ThreadItem = { kind: "message"; message: MabelMessage };
type ChatIntent = { kind: UsageKind; id: string };
type BeginChatOptions = {
  projectId?: string | null;
  attachments?: AttachedFile[] | null;
  documentIds?: string[];
  prompt?: string | null;
  hiddenInstructions?: string;
  intent?: ChatIntent | null;
};

function isValidConversationPayload(
  payload: MabelConversationMessages | null | undefined,
): payload is MabelConversationMessages {
  return Boolean(payload && Array.isArray(payload.messages) && payload.conversation);
}

function isHiddenGeneratedAttachment(file: MabelMessageAttachment): boolean {
  const name = (file.name || "").toLowerCase();
  return file.source !== "user_upload" && name.endsWith(".js");
}

function hasUploadedId(file: AttachedFile): file is AttachedFile & { uploadedId: string } {
  return typeof file.uploadedId === "string" && file.uploadedId.length > 0;
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

function defaultContextRailWidth(historyOpen: boolean): number {
  if (typeof window === "undefined") return 540;
  const historyWidth = historyOpen ? 256 : 0;
  const available = Math.max(640, window.innerWidth - historyWidth);
  const minMainWidth = 420;
  const minContextWidth = 420;
  const maxContextWidth = Math.max(minContextWidth, available - minMainWidth);
  return Math.min(maxContextWidth, Math.max(minContextWidth, Math.round(available / 2)));
}

function compactContextRailWidth(): number {
  return 340;
}

function readMabelUrlState(): { view: MabelView | null; conversationId: number | null; prompt: string | null } {
  if (typeof window === "undefined") return { view: null, conversationId: null, prompt: null };
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get("view");
  const conversationParam = params.get("c");
  const conversationId = conversationParam ? Number(conversationParam) : NaN;
  // Deep links can prefill a new chat's
  // composer with this text. Prefill only, never auto-send; capped so the URL
  // cannot carry an unbounded payload.
  const messageParam = params.get("message");
  const prompt = messageParam && messageParam.trim() ? messageParam.slice(0, 2000) : null;
  return {
    view: viewParam && MABEL_VIEWS.has(viewParam as MabelView) ? (viewParam as MabelView) : null,
    conversationId: Number.isFinite(conversationId) && conversationId > 0 ? conversationId : null,
    prompt,
  };
}

function writeMabelUrlState(view: MabelView, conversationId: number | null) {
  if (typeof window === "undefined") return;
  const next = new URLSearchParams();
  if (view === "chat" && conversationId !== null && conversationId > 0) {
    next.set("c", String(conversationId));
  } else if (view !== "chat") {
    next.set("view", view);
  }
  const nextValue = next.toString();
  const url = nextValue ? `${window.location.pathname}?${nextValue}` : window.location.pathname;
  if (`${window.location.pathname}${window.location.search}` !== url) {
    window.history.replaceState(null, "", url);
  }
}

const MABEL_LAST_VIEW_KEY = "mabel-last-view";

function readMabelLastView(): MabelView | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(MABEL_LAST_VIEW_KEY);
  if (!stored || !MABEL_VIEWS.has(stored as MabelView) || stored === "chat" || stored === "logs") {
    return null;
  }
  return stored as MabelView;
}

function persistMabelView(view: MabelView, conversationId: number | null) {
  writeMabelUrlState(view, view === "chat" ? conversationId : null);
  if (typeof window === "undefined") return;
  if (view === "chat" && conversationId === null) {
    window.localStorage.removeItem(MABEL_LAST_VIEW_KEY);
    return;
  }
  if (view !== "chat") {
    window.localStorage.setItem(MABEL_LAST_VIEW_KEY, view);
  }
}

function readInitialMabelRoute(): { view: MabelView; openingConversationId: number | null; pendingPrompt: string | null } {
  const { view: viewParam, conversationId, prompt } = readMabelUrlState();
  if (conversationId) {
    return { view: "chat", openingConversationId: conversationId, pendingPrompt: null };
  }
  // A prefilled message opens a fresh chat, so it takes precedence over a
  // remembered non-chat view.
  if (prompt) {
    return { view: "chat", openingConversationId: null, pendingPrompt: prompt };
  }
  if (viewParam && viewParam !== "chat") {
    if (viewParam === "logs") {
      return { view: "chat", openingConversationId: null, pendingPrompt: null };
    }
    return { view: viewParam, openingConversationId: null, pendingPrompt: null };
  }
  const lastView = readMabelLastView();
  if (lastView) {
    return { view: lastView, openingConversationId: null, pendingPrompt: null };
  }
  return { view: "chat", openingConversationId: null, pendingPrompt: null };
}

export default function MabelPage() {
  const [bootstrap, setBootstrap] = useState<MabelBootstrap>(EMPTY_BOOTSTRAP);
  const [conversations, setConversations] = useState<MabelConversationSummary[]>([]);
  const [projects, setProjects] = useState<MabelProject[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [initialSetupPending, setInitialSetupPending] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [contextOpen, setContextOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  /** Which assistant turn the Activity panel is focused on. `null` =
   *  fall back to the most recent assistant turn. The inline MessageSteps
   *  blocks pass their owning message id here on click so the user can
   *  jump Activity between turns without scrolling through the whole
   *  thread of "Thought for Ns" rows. */
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const initialRouteRef = useRef(readInitialMabelRoute());
  const [view, setView] = useState<MabelView>(() => initialRouteRef.current.view);
  const [openingConversationId, setOpeningConversationId] = useState<number | null>(
    () => initialRouteRef.current.openingConversationId,
  );
  const [conversationRestorePending, setConversationRestorePending] = useState(
    () => initialRouteRef.current.openingConversationId !== null,
  );
  const [memoryItems, setMemoryItems] = useState<MabelMemoryItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomePlayGame, setWelcomePlayGame] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingComposerAttachments, setPendingComposerAttachments] = useState<AttachedFile[] | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [skillsSearchPrefill, setSkillsSearchPrefill] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [artifact, setArtifact] = useState<MabelArtifact | null>(null);
  const [previewFile, setPreviewFile] = useState<MabelMessageAttachment | null>(null);
  const [contextRailWidth, setContextRailWidth] = useState(() => compactContextRailWidth());
  const [resizingContextRail, setResizingContextRail] = useState(false);
  const [usageRequestCount, setUsageRequestCount] = useState(0);
  const [artifactCount, setArtifactCount] = useState<number | null>(null);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [composerSkills, setComposerSkills] = useState<MabelBootstrap["skills"]>([]);
  const [scheduledTaskCount, setScheduledTaskCount] = useState<number | null>(null);
  const [libraryCount, setLibraryCount] = useState<number | null>(null);
  const [adminAccess, setAdminAccess] = useState(false);
  const [adminTokenBadge, setAdminTokenBadge] = useState<string | null>(null);
  /** Bumps PromptComposer’s MCP control back to icon-only when starting a new chat,
   *  loading another thread, or deleting the active conversation — without resetting
   *  when `activeConversationId` is first assigned after send (null → id). */
  const [connectorsComposerUiEpoch, setConnectorsComposerUiEpoch] = useState(0);
  const systemPromptRef = useRef(systemPrompt);
  systemPromptRef.current = systemPrompt;
  // Auto-scroll: keep the thread pinned to the bottom while tokens stream in,
  // but only if the user is already near the bottom — don't yank them back if
  // they scrolled up to read something earlier.
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const userPinnedRef = useRef(true);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(contextRailWidth);
  const contextRailUserResizedRef = useRef(false);
  const autoPreviewHandledKeyRef = useRef("");
  const wasStreamingRef = useRef(false);
  const handledSkillCreateEventKeysRef = useRef<Set<string>>(new Set());
  const handledArtifactIdsRef = useRef<Set<string>>(new Set());
  const previewFileRef = useRef(previewFile);
  previewFileRef.current = previewFile;
  const pendingDocumentIdsRef = useRef<string[]>([]);
  const openConversationReqIdRef = useRef(0);
  const shellRef = useRef<HTMLElement | null>(null);
  const chatTopbarRef = useRef<HTMLElement | null>(null);

  // Activity rail header sits in a different grid column than `mabel-chat-topbar`.
  // When the topbar wraps (long title + meta), keep the Activity header min-height
  // in sync so the bottom borders stay aligned.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const topbar = chatTopbarRef.current;
    if (!shell || !topbar) return;

    const clear = () => {
      shell.style.removeProperty("--mabel-chat-topbar-height");
    };

    if (!contextOpen || view !== "chat") {
      clear();
      return;
    }

    const sync = () => {
      const h = topbar.getBoundingClientRect().height;
      if (!Number.isFinite(h) || h <= 0) return;
      shell.style.setProperty("--mabel-chat-topbar-height", `${Math.ceil(h)}px`);
    };

    sync();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(sync);
      ro.observe(topbar);
    }
    window.addEventListener("resize", sync);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", sync);
      clear();
    };
  }, [contextOpen, view]);

  const handleOpenArtifact = useCallback((next: MarkdownArtifact) => {
    setArtifact({ language: next.language, value: next.value });
    setPreviewFile(null);
    if (!contextRailUserResizedRef.current) {
      setContextRailWidth(defaultContextRailWidth(historyOpen));
    }
    setContextOpen(true);
  }, [historyOpen]);

  const handleOpenFilePreview = useCallback((file: MabelMessageAttachment) => {
    setPreviewFile(file);
    setArtifact(null);
    if (!contextRailUserResizedRef.current) {
      setContextRailWidth(defaultContextRailWidth(historyOpen));
    }
    setContextOpen(true);
  }, [historyOpen]);

  // Track whether the user is still pinned to the bottom of the thread. If
  // they scroll up themselves, we stop auto-scrolling. If they scroll back
  // near the bottom, auto-scroll resumes.
  const handleMessageListScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userPinnedRef.current = distanceFromBottom < 120;
  }, []);

  // Per-page recent sessions: client-tracked which conversations were initiated
  // from each Skill / Connector / Workflow item.
  const { usage, record: recordUsage, pruneMissingConversations } = useUsageTracker();
  // The "intent" of the next chat send (which Skill/Connector/Pack triggered it).
  const intentRef = useRef<{ kind: UsageKind; id: string } | null>(null);
  const pendingHiddenInstructionsRef = useRef<string>("");

  const instructionsGetter = useCallback(() => {
    const trimmed = systemPromptRef.current.trim();
    const hidden = pendingHiddenInstructionsRef.current.trim();
    return [trimmed, hidden].filter(Boolean).join("\n\n") || undefined;
  }, []);

  // Stale-response guarded refreshes: only the latest in-flight response wins.
  // We MERGE with locally-tracked optimistic / pending rows so a slow server
  // response can never wipe out a row the user just optimistically inserted.
  const refreshConversations = useCallback(async () => {
    const myId = ++__conversationsReqId;
    try {
      const rows = await getMabelConversations();
      if (myId !== __conversationsReqId) return;
      setConversations((prev) => {
        const pending = pendingChatRef.current;
        const merged: MabelConversationSummary[] = [];
        const seenIds = new Set<number>();
        const seenKeys = new Set<string>();

        // 1. Carry over the pending row if it exists, mapped to the server row
        //    when the real id is known, otherwise as-is.
        if (pending.clientKey) {
          if (pending.conversationId !== null) {
            const serverMatch = rows.find((r) => r.id === pending.conversationId);
            if (serverMatch) {
              merged.push({ ...serverMatch, client_key: pending.clientKey });
              seenIds.add(serverMatch.id);
              seenKeys.add(pending.clientKey);
            } else {
              const localMatch = prev.find((c) => c.client_key === pending.clientKey);
              if (localMatch) {
                merged.push(localMatch);
                seenKeys.add(pending.clientKey);
                if (localMatch.id > 0) seenIds.add(localMatch.id);
              }
            }
          } else {
            const localMatch = prev.find((c) => c.client_key === pending.clientKey);
            if (localMatch) {
              merged.push(localMatch);
              seenKeys.add(pending.clientKey);
            }
          }
        }

        for (const row of rows) {
          if (seenIds.has(row.id)) continue;
          // Carry over stable client keys from prev for rows that already had one.
          const prevMatch = prev.find((c) => c.id === row.id);
          merged.push(prevMatch?.client_key ? { ...row, client_key: prevMatch.client_key } : row);
        }
        return merged;
      });
      setConversationsLoaded(true);
    } catch {
      // keep current state on transient error
    }
  }, []);

  const refreshBootstrap = useCallback(async (options: { force?: boolean } = { force: true }) => {
    const myId = ++__bootstrapReqId;
    try {
      const payload = await fetchMabelCached(
        mabelCacheKey("bootstrap"),
        () => getMabelBootstrap(),
        { force: options.force },
      );
      if (myId === __bootstrapReqId) {
        setBootstrap(payload);
      }
    } catch {
      // keep current state on transient error
    }
  }, []);

  const refreshUsageCount = useCallback(async () => {
    try {
      const summary = await fetchMabelCached(mabelCacheKey("usage", 7), () => getMabelUsageSummary({ days: 7 }));
      setUsageRequestCount(Number(summary.totals?.requests || 0));
    } catch {
      // keep current state on transient error
    }
  }, []);

  const refreshScheduledCount = useCallback(async () => {
    try {
      const payload = await fetchMabelCached(mabelCacheKey("scheduled"), () => getMabelScheduled());
      setScheduledTaskCount(payload.tasks.filter((task) => task.status === "active").length);
    } catch {
      // keep current state on transient error
    }
  }, []);

  const refreshProjects = useCallback(async (): Promise<MabelProject[]> => {
    const requestId = ++__projectsReqId;
    try {
      const rows = await fetchMabelCached(mabelCacheKey("projects"), () => getMabelProjects());
      if (requestId === __projectsReqId) setProjects(rows);
      return rows;
    } catch {
      return [];
    }
  }, []);

  const refreshLibraryCount = useCallback(async () => {
    try {
      const files = await fetchMabelCached(mabelCacheKey("library"), () => getMabelFiles());
      setLibraryCount(files.length);
    } catch {
      setLibraryCount(null);
    }
  }, []);

  const refreshArtifactCount = useCallback(async () => {
    try {
      const rows = await fetchMabelCached(mabelCacheKey("artifacts"), () => getMabelArtifacts());
      setArtifactCount(rows.length);
    } catch {
      setArtifactCount(null);
    }
  }, []);

  const refreshSkillCount = useCallback(async () => {
    try {
      const rows = await fetchMabelCached(mabelCacheKey("skills", "all"), () => getMabelSkills());
      setSkillCount(rows.length);
      setComposerSkills(rows);
    } catch {
      setSkillCount(null);
    }
  }, []);

  const refreshAdminAccess = useCallback(async () => {
    try {
      const access = await getMabelAdminAccess();
      setAdminAccess(Boolean(access.is_admin));
      if (access.is_admin) {
        const logs = await fetchMabelCached(mabelLogsCacheKey(), () => getMabelAdminLogs({ days: 7, limit: MABEL_LOGS_PAGE_LIMIT }));
        setAdminTokenBadge(compactCount(Number(logs.totals?.total_tokens || 0)));
      } else {
        setAdminTokenBadge(null);
      }
    } catch {
      setAdminAccess(false);
      setAdminTokenBadge(null);
    }
  }, []);

  const refreshMemory = useCallback(async (query?: string) => {
    try {
      const rows = await fetchMabelCached(mabelCacheKey("memory", query || ""), () => getMabelMemory(query));
      setMemoryItems(rows);
    } catch {
      // keep current state on transient error
    }
  }, []);

  const refreshDeferredCounts = useCallback(async () => {
    await Promise.all([
      refreshProjects(),
      refreshLibraryCount(),
      refreshScheduledCount(),
      refreshArtifactCount(),
      refreshSkillCount(),
      refreshUsageCount(),
      refreshAdminAccess(),
      refreshMemory(),
    ]);
  }, [refreshProjects, refreshLibraryCount, refreshScheduledCount, refreshArtifactCount, refreshSkillCount, refreshUsageCount, refreshAdminAccess, refreshMemory]);

  const refreshAll = useCallback(async (options?: { invalidateCache?: boolean }) => {
    if (options?.invalidateCache) {
      invalidateMabelCache();
    }
    await Promise.all([
      refreshBootstrap(),
      refreshConversations(),
      refreshDeferredCounts(),
    ]);
  }, [refreshBootstrap, refreshConversations, refreshDeferredCounts]);

  const refreshAllHard = useCallback(() => refreshAll({ invalidateCache: true }), [refreshAll]);

  // Track the in-flight optimistic chat: stable client key + final server id.
  // Stored in a ref so it survives across the SSE event handler closure.
  const activeConversationIdRef = useRef<number | null>(null);
  const pendingChatRef = useRef<{ clientKey: string; conversationId: number | null }>(
    { clientKey: "", conversationId: null },
  );

  const cancelPendingConversationOpen = useCallback(() => {
    openConversationReqIdRef.current += 1;
  }, []);

  const clearPreviewSurface = useCallback(() => {
    setArtifact(null);
    setPreviewFile(null);
    autoPreviewHandledKeyRef.current = "";
  }, []);

  const navigateAwayFromChat = useCallback(
    (nextView: MabelView) => {
      cancelPendingConversationOpen();
      setView(nextView);
      persistMabelView(nextView, null);
    },
    [cancelPendingConversationOpen],
  );

  useLayoutEffect(() => {
    const route = initialRouteRef.current;
    persistMabelView(route.view, route.openingConversationId);
  }, []);

  const upsertOptimisticConversation = useCallback((title: string) => {
    const clientKey = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingChatRef.current = { clientKey, conversationId: null };
    const nowIso = new Date().toISOString();
    setConversations((prev) => {
      const withoutSentinel = prev.filter((c) => c.client_key !== clientKey && c.id !== OPTIMISTIC_CONVERSATION_ID);
      return [
        {
          id: OPTIMISTIC_CONVERSATION_ID,
          title: title.length > 80 ? `${title.slice(0, 77)}...` : title,
          surface: "chat",
          project_id: activeProjectId,
          project_name: projects.find((project) => project.id === activeProjectId)?.name || null,
          message_count: 1,
          updated_at: nowIso,
          client_key: clientKey,
        },
        ...withoutSentinel,
      ];
    });
  }, [activeProjectId, projects]);

  const promoteOptimisticConversation = useCallback(
    (conversationId: number, title: string) => {
      const clientKey = pendingChatRef.current.clientKey;
      const nowIso = new Date().toISOString();
      setConversations((prev) => {
        // Preserve the same client_key (React identity) — only swap the server id.
        const list = [...prev];
        const idx = list.findIndex((c) => c.client_key === clientKey);
        if (idx >= 0) {
          list[idx] = {
            ...list[idx],
            id: conversationId,
            title: title.length > 80 ? `${title.slice(0, 77)}...` : title,
            updated_at: nowIso,
          };
          // Bring to top.
          const [row] = list.splice(idx, 1);
          list.unshift(row);
          return list;
        }
        // Defensive: if for some reason the sentinel is gone, insert fresh.
        const cleaned = prev.filter((c) => c.id !== conversationId);
        return [
          {
            id: conversationId,
            title: title.length > 80 ? `${title.slice(0, 77)}...` : title,
            surface: "chat",
            project_id: activeProjectId,
            project_name: projects.find((project) => project.id === activeProjectId)?.name || null,
            message_count: 2,
            updated_at: nowIso,
            client_key: clientKey,
          },
          ...cleaned,
        ];
      });
      // CRITICAL: clear pendingChatRef once the row is promoted. After this point
      // it's a normal conversation row and the per-row key-preservation in
      // refreshConversations handles identity. If we left this set, the "pin
      // pending to top" branch would clobber the natural updated_at ordering and
      // a freshly-renamed or freshly-touched row would lose its top position.
      pendingChatRef.current = { clientKey: "", conversationId: null };
    },
    [activeProjectId, projects],
  );

  const {
    messages,
    toolEvents,
    reasoningByTurn,
    turnTimingByMessageId,
    isStreaming,
    error,
    send,
    stop,
    startNewChat,
    activeConversationId,
    hydrateConversation,
    regenerateLast,
    runStartMyDayDemo,
  } = useMabelStream("chat", {
    instructions: instructionsGetter,
    onSendStarted: (firstUserMessage) => {
      // Instant: the new chat appears in the left rail the moment the user hits Send.
      upsertOptimisticConversation(firstUserMessage);
      // Auto-open the Activity panel so the user can see tool calls live.
      setContextOpen(true);
      // Clear any prior turn selection so the Activity falls back to the
      // newest turn while it's running.
      setSelectedTurnId(null);
    },
    onConversationCreated: (conversationId, firstUserMessage) => {
      // Backend confirmed the id — swap sentinel → real id, then refresh from server.
      promoteOptimisticConversation(conversationId, firstUserMessage);
      void refreshConversations();
    },
    onRunStarted: (conversationId) => {
      setUsageRequestCount((prev) => prev + 1);
      if (intentRef.current) {
        recordUsage(intentRef.current.kind, intentRef.current.id, conversationId);
        intentRef.current = null;
      }
    },
    onRunCompleted: () => {
      void refreshConversations();
      void refreshUsageCount();
      const conversationId = activeConversationIdRef.current;
      if (conversationId !== null) {
        void getMabelConversationMessages(conversationId)
          .then((payload) => {
            if (isValidConversationPayload(payload)) {
              setMabelCached(mabelConversationCacheKey(conversationId), payload);
            }
          })
          .catch(() => undefined);
      }
    },
  });

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    const createSkillResults = toolEvents.filter(
      (event) => event.type === "tool_result" && event.tool_name === "mabel_create_skill",
    );
    let shouldRefresh = false;
    for (const event of createSkillResults) {
      const key = event.tool_call_id || `${event.turn_id || "turn"}:${event.detail || ""}`;
      if (!handledSkillCreateEventKeysRef.current.has(key)) {
        handledSkillCreateEventKeysRef.current.add(key);
        shouldRefresh = true;
      }
    }
    if (shouldRefresh) {
      invalidateMabelCache(mabelCacheKey("skills"));
      void Promise.all([refreshBootstrap(), refreshSkillCount()]);
    }
  }, [refreshBootstrap, refreshSkillCount]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("mabel-theme");
    if (storedTheme === "dark" || storedTheme === "light") {
      setTheme(storedTheme);
    } else {
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      setTheme(prefersDark ? "dark" : "light");
    }
    const storedSystem = window.localStorage.getItem("mabel-system-prompt");
    if (storedSystem) setSystemPrompt(storedSystem);
  }, []);

  useEffect(() => {
    if (!resizingContextRail) return;
    const onMouseMove = (event: MouseEvent) => {
      const viewportWidth = window.innerWidth;
      const historyWidth = historyOpen ? 256 : 0;
      const minMainWidth = 420;
      const minContextWidth = 420;
      const maxWidth = Math.max(minContextWidth, viewportWidth - historyWidth - minMainWidth);
      const delta = resizeStartXRef.current - event.clientX;
      const next = Math.min(maxWidth, Math.max(minContextWidth, resizeStartWidthRef.current + delta));
      setContextRailWidth(next);
      contextRailUserResizedRef.current = true;
    };
    const onMouseUp = () => setResizingContextRail(false);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [historyOpen, resizingContextRail]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const narrow = window.matchMedia("(max-width: 880px)");
    const syncHistoryForViewport = () => {
      if (narrow.matches) setHistoryOpen(false);
    };
    syncHistoryForViewport();
    if (narrow.addEventListener) {
      narrow.addEventListener("change", syncHistoryForViewport);
      return () => narrow.removeEventListener("change", syncHistoryForViewport);
    }
    narrow.addListener?.(syncHistoryForViewport);
    return () => narrow.removeListener?.(syncHistoryForViewport);
  }, []);

  useEffect(() => {
    if (bootstrap.approvals.length > 0 && view === "chat") {
      setContextOpen(true);
    }
  }, [bootstrap.approvals.length, view]);

  useEffect(() => {
    window.localStorage.setItem("mabel-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("mabel-system-prompt", systemPrompt);
  }, [systemPrompt]);

  // Whenever a brand-new message lands (length grows), clear any prior
  // turn selection so the Activity panel snaps to the latest turn.
  // `useMabelStream`'s `onSendStarted` only fires for NEW conversations
  // — without this, sending a follow-up after clicking an older Steps
  // block leaves Activity parked on the wrong turn while the new run
  // is already going.
  const lastMessagesCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > lastMessagesCountRef.current && selectedTurnId !== null) {
      setSelectedTurnId(null);
    }
    lastMessagesCountRef.current = messages.length;
  }, [messages.length, selectedTurnId]);

  useEffect(() => {
    const justFinished = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;
    if (!justFinished || view !== "chat") return;
    const lastAssistantWithFiles = [...messages]
      .reverse()
      .find((row) => row.role === "assistant" && (row.attachments?.length || 0) > 0);
    if (!lastAssistantWithFiles) return;
    const previewCandidate = sortPreviewableAttachments(lastAssistantWithFiles.attachments || []).find((file) => {
      if (isHiddenGeneratedAttachment(file)) return false;
      return !(file.mime_type || "").toLowerCase().startsWith("image/");
    });
    if (!previewCandidate) return;
    const key = `${lastAssistantWithFiles.id}:${previewCandidate.id}`;
    if (autoPreviewHandledKeyRef.current === key) return;
    autoPreviewHandledKeyRef.current = key;
    setPreviewFile(previewCandidate);
    setArtifact(null);
    if (!contextRailUserResizedRef.current) {
      setContextRailWidth(defaultContextRailWidth(historyOpen));
    }
    setContextOpen(true);
  }, [historyOpen, isStreaming, messages, view]);

  const lastPreviewModeRef = useRef<"compact" | "preview">("compact");
  useEffect(() => {
    if (view !== "chat" || !contextOpen || resizingContextRail) return;
    const mode: "compact" | "preview" = previewFile || artifact ? "preview" : "compact";
    if (mode === lastPreviewModeRef.current) return;
    lastPreviewModeRef.current = mode;
    if (contextRailUserResizedRef.current) return;
    setContextRailWidth(mode === "preview" ? defaultContextRailWidth(historyOpen) : compactContextRailWidth());
  }, [artifact, contextOpen, historyOpen, previewFile, resizingContextRail, view]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [bootstrapPayload] = await Promise.all([
          fetchMabelCached(mabelCacheKey("bootstrap"), () => getMabelBootstrap()),
          refreshConversations(),
        ]);
        if (cancelled) return;
        setBootstrap(bootstrapPayload);
        setStatus("ready");
        setInitialSetupPending(false);
        void refreshDeferredCounts();
      } catch {
        if (cancelled) return;
        setStatus("error");
        setInitialSetupPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Auth bootstraps user identity asynchronously in some environments.
    // If initial refresh happened before identity hydration, run one retry
    // shortly after the user becomes available so nav counts are accurate.
    if (getCurrentUser()?.email) return;
    let attempts = 0;
    const intervalId = window.setInterval(() => {
      attempts += 1;
      if (getCurrentUser()?.email) {
        void refreshAll();
        window.clearInterval(intervalId);
        return;
      }
      if (attempts >= 10) {
        window.clearInterval(intervalId);
      }
    }, 500);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshAll]);

  // Deferred nav counts load after the shell is interactive; no duplicate skill refresh.
  //  - on mount (initial Promise.all above)
  //  - on run_started via useMabelStream's onConversationCreated callback
  //  - on run completion via onRunCompleted
  //  - after rename / delete actions
  //  - after CRUD inside Skills/MCP/Workflows pages

  const applyHydratedConversation = useCallback(
    (conversationId: number, payload: MabelConversationMessages, reqId: number) => {
      if (reqId !== openConversationReqIdRef.current) return;
      if (!isValidConversationPayload(payload)) return;
      const hydrated = hydrateConversationPayload(payload);
      setConnectorsComposerUiEpoch((n) => n + 1);
      hydrateConversation(conversationId, hydrated.messageRows, hydrated.tools, hydrated.hydratedReasoning);
      setActiveProjectId(hydrated.projectId);
      setPendingComposerAttachments(null);
      pendingDocumentIdsRef.current = [];
      setSelectedTurnId(null);
      setView("chat");
      if (hydrated.openContext) setContextOpen(true);
    },
    [hydrateConversation],
  );

  const openConversation = useCallback(
    async (conversationId: number) => {
      const reqId = ++openConversationReqIdRef.current;

      if (activeConversationId === conversationId && messages.length > 0) {
        setView("chat");
        clearPreviewSurface();
        setOpeningConversationId(null);
        setConversationRestorePending(false);
        return;
      }

      const cacheKey = mabelConversationCacheKey(conversationId);
      const cached = getMabelCached<MabelConversationMessages>(cacheKey);
      if (cached && !isValidConversationPayload(cached)) {
        invalidateMabelCache(cacheKey);
      }
      const cachedPayload = isValidConversationPayload(cached) ? cached : null;

      setOpeningConversationId(conversationId);
      setView("chat");
      clearPreviewSurface();

      if (cachedPayload) {
        applyHydratedConversation(conversationId, cachedPayload, reqId);
        setOpeningConversationId(null);
        setConversationRestorePending(false);
        return;
      }

      try {
        const payload = await fetchMabelCached(cacheKey, () => getMabelConversationMessages(conversationId));
        applyHydratedConversation(conversationId, payload, reqId);
      } catch {
        // keep
      } finally {
        if (reqId === openConversationReqIdRef.current) {
          setOpeningConversationId(null);
          setConversationRestorePending(false);
        }
      }
    },
    [activeConversationId, applyHydratedConversation, clearPreviewSurface, messages.length],
  );

  useEffect(() => {
    if (status !== "ready") return;
    const { view: viewParam, conversationId } = readMabelUrlState();
    if (conversationId) {
      void openConversation(conversationId);
      return;
    }
    if (viewParam === "logs" && adminAccess) {
      setView("logs");
      persistMabelView("logs", null);
    }
  }, [adminAccess, openConversation, status]);

  useEffect(() => {
    persistMabelView(view, activeConversationId);
  }, [activeConversationId, view]);

  // Keep usage tracker in sync — if a conversation was deleted, drop it from
  // the per-page recent-sessions buckets.
  useEffect(() => {
    if (!conversationsLoaded) return;
    pruneMissingConversations(new Set(conversations.map((c) => c.id)));
  }, [conversations, conversationsLoaded, pruneMissingConversations]);

  const beginChat = useCallback((options: BeginChatOptions = {}) => {
    cancelPendingConversationOpen();
    clearPreviewSurface();
    startNewChat();
    handledArtifactIdsRef.current = new Set();
    intentRef.current = options.intent || null;
    pendingHiddenInstructionsRef.current = options.hiddenInstructions || "";
    pendingDocumentIdsRef.current = options.documentIds || [];
    setConnectorsComposerUiEpoch((n) => n + 1);
    setActiveProjectId(options.projectId || null);
    setPendingComposerAttachments(options.attachments || null);
    setPendingPrompt(options.prompt || null);
    setSelectedTurnId(null);
    setView("chat");
    setContextOpen(false);
  }, [cancelPendingConversationOpen, clearPreviewSurface, startNewChat]);

  const handleNewChat = useCallback(() => {
    beginChat();
  }, [beginChat]);

  // Deep-link prefill: if the page opened with ?message=, start a fresh chat
  // with that text in the composer (prefill only, no auto-send). Runs once; the
  // URL param is already stripped by persistMabelView on mount, so a refresh
  // will not resend it.
  const urlPromptAppliedRef = useRef(false);
  useEffect(() => {
    if (urlPromptAppliedRef.current) return;
    const prompt = initialRouteRef.current.pendingPrompt;
    if (!prompt) return;
    urlPromptAppliedRef.current = true;
    beginChat({ prompt });
  }, [beginChat]);

  // Auto-open dashboard/html artifacts in the right canvas rail when mabel_save_artifact fires.
  useEffect(() => {
    for (const event of toolEvents) {
      if (event.type !== "tool_result" || event.tool_name !== "mabel_save_artifact") continue;
      if (!event.detail) continue;
      let parsed: { artifact?: { id?: string; kind?: string; created_at?: string }; visible_in_artifacts?: boolean };
      try { parsed = JSON.parse(event.detail); } catch { continue; }
      const { id: artifactId, kind, created_at } = parsed?.artifact ?? {};
      if (!artifactId || !parsed?.visible_in_artifacts) continue;
      if (!["dashboard", "html"].includes(kind ?? "")) continue;
      if (handledArtifactIdsRef.current.has(artifactId)) continue;
      if (created_at && Date.now() - new Date(created_at).getTime() > 60_000) continue;
      handledArtifactIdsRef.current.add(artifactId);
      setArtifactCount((n) => (n ?? 0) + 1);
      void (async () => {
        try {
          const doc = await getMabelArtifact(artifactId);
          handleOpenArtifact({ language: "html", value: doc.content });
        } catch { /* silently fail — artifact is still saved */ }
      })();
    }
  }, [toolEvents]);

  const handleSubmit = useCallback(
    (text: string, attachments: AttachedFile[]) => {
      // Auto-open Activity on every send so the user sees tool calls live.
      setContextOpen(true);
      // PromptComposer only forwards attachments with status === "ready" and
      // every ready attachment has a server-side `uploadedId`. We use those
      // ids directly — no second upload round-trip at send time.
      const readyAttachments = attachments.filter(hasUploadedId);
      const attachmentIds = readyAttachments.map((a) => a.uploadedId);
      const userAttachments: MabelMessageAttachment[] = readyAttachments.map((a) => ({
        id: a.uploadedId,
        name: a.name,
        mime_type: a.type,
        size_bytes: a.size,
        source: "user_upload",
      }));
      void send(text, {
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        userAttachments: userAttachments.length > 0 ? userAttachments : undefined,
        documentIds: pendingDocumentIdsRef.current.length > 0 ? pendingDocumentIdsRef.current : undefined,
        projectId: activeProjectId || undefined,
      });
      pendingHiddenInstructionsRef.current = "";
      pendingDocumentIdsRef.current = [];
    },
    [activeProjectId, send],
  );

  const handleStarter = useCallback(
    (text: string, hiddenInstructions?: string) => {
      beginChat({ prompt: text, hiddenInstructions });
    },
    [beginChat],
  );

  const handlePromptInsert = useCallback((text: string, intent?: ChatIntent, hiddenInstructions?: string) => {
    beginChat({ prompt: text, intent, hiddenInstructions });
  }, [beginChat]);

  const handleRunWorkflowPack = useCallback(async (pack: { id: string; name: string }) => {
    if (pack.id === START_MY_DAY_WORKFLOW_ID) {
      beginChat({ intent: { kind: "pack", id: pack.id } });
      setContextOpen(true);
      await runStartMyDayDemo();
      return;
    }
    const run = await runMabelWorkflow(pack.id, {
      objective: `Run ${pack.name} workflow with checkpoints and draft outputs.`,
      dry_run: false,
    });
    const continueAction = run.outputs?.next_actions?.find((action) => action.kind === "open_chat" && action.prompt);
    beginChat({
      prompt: continueAction?.prompt || `Use ${pack.name} workflow.`,
      intent: { kind: "pack", id: pack.id },
      hiddenInstructions: `First call mabel_get_starter_pack with starter_pack_id="${pack.id}", then load each required skill with mabel_get_skill before using MCP tools.`,
    });
    setContextOpen(true);
  }, [beginChat, runStartMyDayDemo]);

  const handlePromptInsertInCurrentChat = useCallback((text: string, hiddenInstructions?: string) => {
    intentRef.current = null;
    pendingHiddenInstructionsRef.current = hiddenInstructions || "";
    setPendingPrompt(null);
    setView("chat");
    window.setTimeout(() => setPendingPrompt(text), 0);
  }, []);

  const handleSlashAction = useCallback(
    (action: SlashAction) => {
      if (action.type === "start-my-day") {
        void handleRunWorkflowPack({ id: START_MY_DAY_WORKFLOW_ID, name: "Start My Day" });
        return;
      }
      if (action.type === "prompt") {
        setPendingPrompt(action.text);
        setView("chat");
        return;
      }
      if (action.type === "settings") {
        setSettingsOpen(true);
        return;
      }
      if (action.type === "help") {
        setPendingPrompt(
          "Show what Mabel can do: list connectors, skills, starter packs, and explain controlled actions and approvals.",
        );
        setView("chat");
      }
    },
    [handleRunWorkflowPack],
  );

  const handleUsageSummary = useCallback((summary: { totals?: { requests?: number } }) => {
    setUsageRequestCount(Number(summary.totals?.requests || 0));
  }, []);

  const handleAskMabelFromContext = useCallback(
    (prompt: string) => {
      beginChat({ prompt });
      setContextOpen(true);
    },
    [beginChat],
  );

  const handleStartProjectChat = useCallback((project: MabelProject) => {
    beginChat({ projectId: project.id });
  }, [beginChat]);

  const handleOpenLibraryFile = useCallback((file: MabelUploadedFile) => {
    handleOpenFilePreview(file);
  }, [handleOpenFilePreview]);

  const handleChatWithLibraryFile = useCallback((file: MabelUploadedFile) => {
    beginChat({
      attachments: [
        {
          kind: "library",
          id: `library-${file.id}`,
          name: file.name,
          size: file.size_bytes,
          type: file.mime_type,
          uploadedId: file.id,
          status: "ready",
        },
      ],
    });
  }, [beginChat]);

  const handleDeleteMemory = useCallback(
    async (itemId: string) => {
      await deleteMabelMemory(itemId);
      await refreshMemory();
    },
    [refreshMemory],
  );

  const handleExportMemory = useCallback(async () => {
    const payload = await exportMabelMemory();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mabel-memory-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);

  const toggleTheme = () => {
    const shell = document.querySelector('.mabel-app-shell');
    if (shell) {
      shell.classList.add('mabel-theme-switching');
      requestAnimationFrame(() => {
        setTimeout(() => shell.classList.remove('mabel-theme-switching'), 50);
      });
    }
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const renameConversation = useCallback(
    async (conversationId: number, nextTitle: string) => {
      // optimistic local update
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, title: nextTitle } : c)),
      );
      try {
        await renameMabelConversation(conversationId, nextTitle);
      } finally {
        await refreshConversations();
      }
    },
    [refreshConversations],
  );

  const removeConversation = useCallback(
    async (conversationId: number) => {
      // optimistic local update
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      try {
        await deleteMabelConversation(conversationId);
        if (conversationId === activeConversationId) {
          startNewChat();
          setConnectorsComposerUiEpoch((n) => n + 1);
        }
      } finally {
        await refreshConversations();
      }
    },
    [activeConversationId, refreshConversations, startNewChat],
  );

  const requestDeleteConversation = (conversationId: number) => setConfirmDeleteId(conversationId);

  const confirmDeleteConversation = async () => {
    if (confirmDeleteId === null) return;
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    await removeConversation(id);
  };

  const visibleMessages = useMemo(() => messages.filter((m) => m.role !== "system"), [messages]);
  const hasConversationContent = visibleMessages.length > 0 || toolEvents.length > 0;

  // Token-watcher: each new chunk of assistant text or new tool event scrolls
  // the message list to the bottom, but only when the user is pinned there.
  // We use the assistant's tail content length as the trigger so every
  // streamed delta nudges the scroll position down.
  const lastAssistantContentLength = (() => {
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      if (visibleMessages[i].role === "assistant") return visibleMessages[i].content.length;
    }
    return 0;
  })();
  useLayoutEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    if (!userPinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [
    visibleMessages.length,
    lastAssistantContentLength,
    toolEvents.length,
    isStreaming,
  ]);

  // When a new user turn starts, force-pin to bottom so the user sees the
  // streaming reply even if they scrolled up to read history.
  const lastUserMessageId =
    [...visibleMessages].reverse().find((m) => m.role === "user")?.id;
  useEffect(() => {
    if (!lastUserMessageId) return;
    userPinnedRef.current = true;
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastUserMessageId]);

  const dedupedThreadMessages = useMemo(() => {
    const seenAssistantAttachments = new Set<string>();
    return visibleMessages.map((message) => {
      if (message.role !== "assistant" || !message.attachments || message.attachments.length === 0) {
        return message;
      }
      const filtered = message.attachments.filter((file) => {
        const key = `${(file.name || "").toLowerCase()}::${(file.mime_type || "").toLowerCase()}`;
        if (seenAssistantAttachments.has(key)) return false;
        seenAssistantAttachments.add(key);
        return true;
      });
      const sorted = sortPreviewableAttachments(filtered);
      if (filtered.length === message.attachments.length && sorted.every((file, index) => file === message.attachments?.[index])) return message;
      return { ...message, attachments: sorted };
    });
  }, [visibleMessages]);

  const threadItems = useMemo<ThreadItem[]>(() => {
    if (toolEvents.length === 0) {
      return dedupedThreadMessages.map((message) => ({ kind: "message" as const, message }));
    }

    // Tool calls used to render inline between the user prompt and the
    // assistant reply as boxy "tool-stack" cards. The boxes felt heavy and
    // duplicated the Activity panel's chain-of-thought on the right.
    // We now show tools ONLY in Activity (prompt-kit Steps style) — the
    // main thread stays a clean back-and-forth of user/assistant messages.
    const items: ThreadItem[] = dedupedThreadMessages.map((message) => ({
      kind: "message",
      message,
    }));
    return items;
  }, [dedupedThreadMessages, toolEvents.length]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) || null,
    [activeProjectId, projects],
  );
  const recentConversations = conversations;

  const activeTitle = useMemo(() => {
    if (view === "projects") return "Projects";
    if (view === "library") return "Library";
    if (view === "memory") return "Memory";
    if (view === "connectors") return "Connectors";
    if (view === "skills") return "Skills";
    if (view === "workflows") return "Workflows";
    if (view === "artifacts") return "Artifacts";
    if (view === "scheduled") return "Scheduled";
    if (view === "usage") return "Usage";
    if (view === "logs") return "Logs";
    if (activeConversationId === null) return "New chat";
    const match = conversations.find((c) => c.id === activeConversationId);
    return match?.title || "Conversation";
  }, [activeConversationId, conversations, view]);

  const connectorNavCount = useMemo(
    () => mabelUiEnabledConnectors(bootstrap.connectors).length,
    [bootstrap.connectors],
  );

  const shouldRevealConnectors = useMemo(
    () =>
      toolEvents.some((event) =>
        event.tool_name === "mabel_call_mcp_tool" ||
        event.tool_name === "mabel_list_mcp_tools" ||
        (event.tool_name.includes("_") && !event.tool_name.startsWith("mabel_")),
      ),
    [toolEvents],
  );

  const visibleSkillCount = skillCount ?? bootstrap.skills.length;
  const composerSlashCommands = useMemo(() => {
    if (!bootstrap.starter_packs.some((pack) => pack.id === START_MY_DAY_WORKFLOW_ID)) {
      return [];
    }
    return [
      {
        key: "/start-my-day",
        label: "/start-my-day",
        hint: "Run Start My Day workflow",
        action: { type: "start-my-day" } as SlashAction,
      },
    ];
  }, [bootstrap.starter_packs]);
  const headerMeta = activeProject
    ? `${activeProject.name} · ${connectorNavCount} connectors · ${visibleSkillCount} skills`
    : `${connectorNavCount} connectors · ${visibleSkillCount} skills`;
  const contextRailSupported = view === "chat" || view === "projects" || view === "library";

  return (
    <main
      ref={shellRef}
      className="mabel-app-shell"
      data-theme={theme}
      data-context={contextOpen && contextRailSupported ? "open" : "closed"}
      data-history={historyOpen ? "open" : "closed"}
      data-resizing={resizingContextRail ? "true" : "false"}
      style={{ "--mabel-context-width": `${contextRailWidth}px` } as CSSProperties}
    >
      {initialSetupPending ? (
        <div className="mabel-setup-overlay" role="status" aria-live="polite">
          <div className="mabel-setup-overlay__card">
            <span className="mabel-history-item__spinner" aria-hidden="true" />
            <span>Setting up workspace…</span>
          </div>
        </div>
      ) : null}
      {historyOpen ? (
        <aside className="mabel-history-rail" aria-label="Mabel conversation history">
          <div className="mabel-history-rail__head">
            <div className="mabel-brand">
              <BrandMark className="mabel-brand-mark" />
              <span className="mabel-brand-wordmark">Mabel</span>
            </div>
            <button
              type="button"
              className="mabel-icon-btn"
              onClick={() => setHistoryOpen(false)}
              aria-label="Collapse history panel"
              title="Collapse history"
            >
              <PanelIcon />
            </button>
          </div>

          <button
            type="button"
            className={`mabel-nav-item${view === "chat" ? " mabel-nav-item--active" : ""}`}
            onClick={handleNewChat}
          >
            <PlusIcon />
            <span>New chat</span>
          </button>

          <nav className="mabel-nav">
            <NavItem
              icon={<ProjectsNavIcon />}
              label="Projects"
              count={projects.length}
              active={view === "projects"}
              onClick={() => {
                setContextOpen(false);
                navigateAwayFromChat("projects");
              }}
            />
            <NavItem
              icon={<ConnectorsIcon />}
              label="Connectors"
              count={connectorNavCount}
              active={view === "connectors"}
              onClick={() => navigateAwayFromChat("connectors")}
            />
            <NavItem
              icon={<SkillsIcon />}
              label="Skills"
              count={visibleSkillCount}
              active={view === "skills"}
              onClick={() => navigateAwayFromChat("skills")}
            />
            <NavItem
              icon={<WorkflowsIcon />}
              label="Workflows"
              count={bootstrap.starter_packs.length}
              active={view === "workflows"}
              onClick={() => navigateAwayFromChat("workflows")}
            />
            <NavItem
              icon={<ArtifactsIcon />}
              label="Artifacts"
              count={artifactCount ?? undefined}
              active={view === "artifacts"}
              onClick={() => navigateAwayFromChat("artifacts")}
            />
            <NavItem
              icon={<LibraryNavIcon />}
              label="Library"
              count={libraryCount ?? undefined}
              active={view === "library"}
              onClick={() => {
                setContextOpen(false);
                navigateAwayFromChat("library");
              }}
            />
            <NavItem
              icon={<ScheduledIcon />}
              label="Scheduled"
              count={scheduledTaskCount ?? undefined}
              active={view === "scheduled"}
              onClick={() => navigateAwayFromChat("scheduled")}
            />
            <NavItem
              icon={<MemoryIcon />}
              label="Memory"
              count={memoryItems.length}
              active={view === "memory"}
              onClick={() => {
                navigateAwayFromChat("memory");
                void refreshMemory();
              }}
            />
            <NavItem
              icon={<UsageIcon />}
              label="Usage"
              count={usageRequestCount}
              active={view === "usage"}
              onClick={() => navigateAwayFromChat("usage")}
            />
            {adminAccess ? (
              <NavItem
                icon={<LogsIcon />}
                label="Logs"
                count={adminTokenBadge || undefined}
                active={view === "logs"}
                onClick={() => navigateAwayFromChat("logs")}
              />
            ) : null}
          </nav>

          {recentConversations.length === 0 ? (
            <p className="mabel-empty-copy">Start a conversation to see it here.</p>
          ) : (
            <div className="mabel-history-section">
              <div className="mabel-rail-label">Recent</div>
            {recentConversations.map((conversation) => {
              const isOptimistic = conversation.id === OPTIMISTIC_CONVERSATION_ID;
              // Stable key: client_key survives id promotion → React keeps the row mounted.
              const reactKey = conversation.client_key || `c-${conversation.id}`;
              return (
                <HistoryItem
                  key={reactKey}
                  conversationId={conversation.id}
                  title={conversation.title}
                  isActive={view === "chat" && (isOptimistic ? activeConversationId === null : activeConversationId === conversation.id)}
                  disabled={isOptimistic}
                  loading={openingConversationId === conversation.id}
                  onSelect={() => {
                    if (isOptimistic) return;
                    void openConversation(conversation.id);
                  }}
                  onRename={(next) => (isOptimistic ? Promise.resolve() : renameConversation(conversation.id, next))}
                  onDelete={() => (isOptimistic ? undefined : requestDeleteConversation(conversation.id))}
                />
              );
            })}
            </div>
          )}
        </aside>
      ) : null}

      <section className="mabel-conversation-shell" aria-label="Mabel chat workspace">
        <header ref={chatTopbarRef} className="mabel-chat-topbar">
          <div className="mabel-topbar-title">
            {!historyOpen ? (
              <button
                type="button"
                className="mabel-icon-btn"
                onClick={() => setHistoryOpen(true)}
                aria-label="Open history panel"
                title="Open history"
              >
                <PanelIcon />
              </button>
            ) : null}
            <h1>{activeTitle}</h1>
            {view === "chat" ? (
              <span className="mabel-topbar-meta" title={headerMeta}>· {headerMeta}</span>
            ) : null}
          </div>
          <div className="mabel-topbar-actions">
            <button
              type="button"
              className="mabel-icon-btn"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              title="Settings"
            >
              <SettingsIcon />
            </button>
            <button
              type="button"
              className="mabel-icon-btn"
              onClick={toggleTheme}
              aria-label="Toggle light and dark mode"
              title="Toggle theme"
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </header>

        {view === "chat" ? (
          <>
            <div className="mabel-message-list" ref={messageListRef} onScroll={handleMessageListScroll}>
              {openingConversationId !== null || conversationRestorePending ? (
                <div className="mabel-conversation-loading" role="status" aria-live="polite">
                  <div className="mabel-conversation-loading__inner">
                    <span className="mabel-history-item__spinner" aria-hidden="true" />
                    <span className="mabel-shimmer">Loading conversation…</span>
                  </div>
                </div>
              ) : hasConversationContent ? (
                <div className="mabel-thread">
                  {threadItems.map((item, index) => {
                    const isLast = index === threadItems.length - 1;
                    // Inline Steps: feed only the tools that belong to THIS
                    // assistant turn (matched via turn_id / run_id) so each
                    // message renders its own action timeline above the
                    // bubble. The user message gets none.
                    const turnTools =
                      item.message.role === "assistant"
                        ? toolEvents.filter((event) => event.turn_id === item.message.id)
                        : undefined;
                    const previousUserPrompt =
                      item.message.role === "assistant"
                        ? threadItems.slice(0, index).reverse().find((candidate) => candidate.message.role === "user")?.message.content || ""
                        : "";
                    return (
                      <ThreadMessage
                        key={`m-${item.message.id}`}
                        message={item.message}
                        theme={theme}
                        isLast={isLast}
                        isStreaming={isStreaming}
                        canRegenerate={isLast && item.message.role === "assistant" && !isStreaming}
                        onRegenerate={regenerateLast}
                        onOpenArtifact={handleOpenArtifact}
                        onOpenFile={handleOpenFilePreview}
                        toolEventsForTurn={turnTools}
                        onOpenSkill={(skillId) => {
                          setSkillsSearchPrefill(skillId);
                          navigateAwayFromChat("skills");
                        }}
                        onActivateTurn={() => {
                          // Switch Activity to this turn AND make sure
                          // the right rail is open so the user actually
                          // sees what they just selected.
                          setSelectedTurnId(item.message.id);
                          setContextOpen(true);
                          setArtifact(null);
                        }}
                        onSchedulePrompt={
                          item.message.role === "assistant" && previousUserPrompt
                            ? () =>
                                handlePromptInsertInCurrentChat(
                                  buildSchedulePromptPrompt(previousUserPrompt),
                                  buildSchedulePromptInstructions(previousUserPrompt),
                                )
                            : undefined
                        }
                      />
                    );
                  })}
                  {error ? <div className="mabel-error">{error}</div> : null}
                </div>
              ) : (
                <WelcomePane
                  bootstrap={bootstrap}
                  conversations={conversations}
                  skillCount={visibleSkillCount}
                  onStarter={handleStarter}
                  playGame={welcomePlayGame}
                  onPlayGameChange={setWelcomePlayGame}
                />
              )}
            </div>

            <div className="mabel-composer-dock">
              <PromptComposer
                disabled={isStreaming}
                isStreaming={isStreaming}
                bootstrap={bootstrap}
                mentionSkills={composerSkills.length > 0 ? composerSkills : bootstrap.skills}
                slashCommands={composerSlashCommands}
                onSubmit={handleSubmit}
                onStop={stop}
                onSlashAction={handleSlashAction}
                initialValue={pendingPrompt}
                onInitialConsumed={() => setPendingPrompt(null)}
                initialAttachments={pendingComposerAttachments}
                onInitialAttachmentsConsumed={() => setPendingComposerAttachments(null)}
                contextLabel={
                  activeProject
                    ? `${activeProject.name} · ${activeProject.file_count} project file${activeProject.file_count === 1 ? "" : "s"}`
                    : undefined
                }
                onConnectorsChanged={refreshAllHard}
                connectorsControlResetKey={connectorsComposerUiEpoch}
                autoRevealConnectors={shouldRevealConnectors}
              />
              <p className="mabel-composer-footnote">Uses AI. Verify results.</p>
            </div>
          </>
        ) : null}

        {view === "projects" ? (
          <ProjectsPage
            projects={projects}
            onRefreshProjects={refreshProjects}
            onConversationsChange={refreshConversations}
            onOpenConversation={(conversationId) => void openConversation(conversationId)}
            onStartChat={handleStartProjectChat}
            onOpenFile={handleOpenLibraryFile}
          />
        ) : null}
        {view === "library" ? (
          <LibraryPage
            onOpenFile={handleOpenLibraryFile}
            onChatWithFile={handleChatWithLibraryFile}
            onCountChange={setLibraryCount}
            onProjectFilesChange={refreshProjects}
          />
        ) : null}
        {view === "connectors" ? (
          <ConnectorsPage
            bootstrap={bootstrap}
            onRefresh={refreshAllHard}
            onRefreshBootstrap={refreshBootstrap}
            onUseInChat={handlePromptInsert}
            usage={usage.connector}
            conversations={conversations}
            onOpenConversation={(id) => void openConversation(id)}
          />
        ) : null}
        {view === "memory" ? (
          <MemoryPage
            memoryItems={memoryItems}
            onDelete={handleDeleteMemory}
            onUseInChat={handleAskMabelFromContext}
            onExport={handleExportMemory}
          />
        ) : null}
        {view === "skills" ? (
          <SkillsPage
            bootstrap={bootstrap}
            onRefresh={refreshAllHard}
            onUseInChat={handlePromptInsert}
            usage={usage.skill}
            conversations={conversations}
            onOpenConversation={(id) => void openConversation(id)}
            initialSearch={skillsSearchPrefill}
            onCountChange={setSkillCount}
          />
        ) : null}
        {view === "workflows" ? (
          <WorkflowsPage
            bootstrap={bootstrap}
            onRefresh={refreshAllHard}
            onRunPack={handleRunWorkflowPack}
            onBuildWorkflow={() =>
              handlePromptInsert(BUILD_WORKFLOW_VISIBLE_PROMPT, undefined, BUILD_WORKFLOW_HIDDEN_INSTRUCTIONS)
            }
            usage={usage.pack}
            conversations={conversations}
            onOpenConversation={(id) => void openConversation(id)}
          />
        ) : null}
        {view === "artifacts" ? (
          <ArtifactsPage
            onCreateInChat={handlePromptInsert}
            onOpenArtifact={(next) => {
              handleOpenArtifact(next);
              setContextOpen(true);
            }}
            onOpenConversation={(conversationId) => {
              setView("chat");
              void openConversation(conversationId);
            }}
            onCountChange={setArtifactCount}
          />
        ) : null}
        {view === "scheduled" ? (
          <ScheduledPage
            onCountChange={setScheduledTaskCount}
            onCreateInChat={handlePromptInsert}
            onOpenConversation={(conversationId) => {
              setView("chat");
              void openConversation(conversationId);
            }}
          />
        ) : null}
        {view === "usage" ? <UsagePage onSummary={handleUsageSummary} /> : null}
        {view === "logs" ? <LogsPage /> : null}
      </section>

      {contextOpen && contextRailSupported ? (
        <div
          className="mabel-context-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview panel"
          tabIndex={0}
          onMouseDown={(event) => {
            resizeStartXRef.current = event.clientX;
            resizeStartWidthRef.current = contextRailWidth;
            setResizingContextRail(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const historyWidth = historyOpen ? 256 : 0;
            const maxWidth = Math.max(420, window.innerWidth - historyWidth - 420);
            const delta = event.key === "ArrowLeft" ? 24 : -24;
            setContextRailWidth((current) => Math.min(maxWidth, Math.max(420, current + delta)));
            contextRailUserResizedRef.current = true;
          }}
        />
      ) : null}

      {contextOpen && contextRailSupported ? (
        <aside
          className={`mabel-context-rail${artifact || previewFile ? " mabel-context-rail--artifact" : ""}`}
          aria-label={artifact || previewFile ? "Mabel artifact" : "Mabel activity"}
        >
          {previewFile ? (
            <MabelFilePreviewPanel
              file={previewFile}
              onClose={() => {
                setPreviewFile(null);
                if (view !== "chat") setContextOpen(false);
              }}
            />
          ) : artifact ? (
            <ArtifactPanel
              artifact={artifact}
              theme={theme}
              onClose={() => setArtifact(null)}
            />
          ) : (
            <ActivityPanel
              bootstrap={bootstrap}
              messages={messages}
              toolEvents={toolEvents}
              reasoningByTurn={reasoningByTurn}
              turnTimingByMessageId={turnTimingByMessageId}
              isStreaming={isStreaming}
              selectedTurnId={selectedTurnId}
              theme={theme}
              onRefresh={refreshAllHard}
              onClose={() => setContextOpen(false)}
            />
          )}
        </aside>
      ) : null}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onThemeChange={setTheme}
        systemPrompt={systemPrompt}
        onSystemPromptChange={setSystemPrompt}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete conversation"
        body="The conversation and its messages will be removed. This cannot be undone."
        destructive
        confirmLabel="Delete"
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={confirmDeleteConversation}
      />
    </main>
  );
}

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number | string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`mabel-nav-item${active ? " mabel-nav-item--active" : ""}`}
      onClick={onClick}
    >
      <span className="mabel-nav-item__icon" aria-hidden="true">{icon}</span>
      <span className="mabel-nav-item__label">{label}</span>
      {typeof count === "number" || typeof count === "string" ? <span className="mabel-nav-item__count">{count}</span> : <span />}
    </button>
  );
}

function compactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: value >= 1_000_000 ? 1 : 0 }).format(value);
}

function buildSchedulePromptPrompt(userPrompt: string): string {
  const base = userPrompt.trim() || "the selected Mabel prompt";
  return `Help me schedule this prompt: "${base}"`;
}

function buildSchedulePromptInstructions(userPrompt: string): string {
  const base = userPrompt.trim() || "the selected Mabel prompt";
  return `Explain scheduled Mabel tasks in one concise paragraph. Ask the user for cadence, timezone, and the exact clock time such as 7 AM or 9 PM. The prompt to rerun is: "${base}". If the user gives an exact time, convert it to a 5-field cron expression and call mabel_create_scheduled_task with schedule_kind='cron', cron, timezone, name, and prompt. Do not settle for only morning/daily if the user gave a specific time.`;
}

function ThreadMessage({
  message,
  theme,
  isLast,
  isStreaming,
  canRegenerate,
  onRegenerate,
  onOpenArtifact,
  onOpenFile,
  toolEventsForTurn,
  onOpenSkill,
  onActivateTurn,
  onSchedulePrompt,
}: {
  message: MabelMessage;
  theme: "light" | "dark";
  isLast: boolean;
  isStreaming: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onOpenArtifact?: (artifact: MarkdownArtifact) => void;
  onOpenFile?: (file: MabelMessageAttachment) => void;
  toolEventsForTurn?: MabelToolEvent[];
  onOpenSkill?: (skillId: string) => void;
  onActivateTurn?: () => void;
  onSchedulePrompt?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const showCursor = isLast && isStreaming && message.role === "assistant" && message.content.length === 0;
  const visibleContent = message.role === "assistant" && message.content.length === 0 && !isStreaming
    ? ""
    : message.content;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore
    }
  };

  const attachments = message.attachments || [];
  const isAssistantEmptyStreaming =
    isLast && isStreaming && message.role === "assistant" && message.content.length === 0;
  const showBubble =
    message.role !== "user" || (visibleContent && visibleContent.length > 0);

  return (
    <article className={`mabel-message mabel-message--${message.role}`}>
      <div className="mabel-message-body">
        {message.role === "user" && attachments.length > 0 ? (
          <MessageAttachments attachments={attachments} side="user" />
        ) : null}
        {isAssistantEmptyStreaming ? (
          <div className="mabel-message-loader" aria-live="polite" aria-label="Mabel is thinking">
            <span className="mabel-shimmer">Thinking</span>
          </div>
        ) : null}
        {message.role === "assistant" && ((toolEventsForTurn && toolEventsForTurn.length > 0) || (message.sources && message.sources.length > 0)) ? (
          <MessageSteps
            toolEvents={toolEventsForTurn || []}
            sources={message.sources}
            onActivate={onActivateTurn}
            onOpenSkill={onOpenSkill}
          />
        ) : null}
        {showBubble && !isAssistantEmptyStreaming ? (
          <div className="mabel-message-bubble">
            {message.role === "user" ? (
              <>{visibleContent}</>
            ) : visibleContent ? (
              <Markdown content={visibleContent} theme={theme} onOpenArtifact={onOpenArtifact} />
            ) : null}
            {showCursor ? <span className="mabel-message-cursor" /> : null}
          </div>
        ) : null}
        {message.role !== "user" && attachments.length > 0 ? (
          <MessageAttachments attachments={attachments} side="assistant" onOpenFile={onOpenFile} />
        ) : null}
        {/* Sources are NOT rendered as a standalone gray block under the
         * bubble. They live inside the inline MessageSteps "Searched the
         * web" entry above so the user sees one canonical place for the
         * agent's actions + their citations. */}
        {message.role === "assistant" && message.content ? (
          <div className="mabel-message__actions">
            <button
              type="button"
              className={`mabel-message__action${copied ? " mabel-message__action--done" : ""}`}
              onClick={onCopy}
              aria-label={copied ? "Copied" : "Copy response"}
              title={copied ? "Copied" : "Copy"}
            >
              {copied ? <CheckSmallIcon /> : <CopyIcon />}
            </button>
            {canRegenerate ? (
              <button
                type="button"
                className="mabel-message__action"
                onClick={onRegenerate}
                aria-label="Regenerate response"
                title="Regenerate"
              >
                <RefreshIcon />
              </button>
            ) : null}
            {onSchedulePrompt ? (
              <button
                type="button"
                className="mabel-message__action"
                onClick={onSchedulePrompt}
                aria-label="Schedule prompt"
                title="Schedule prompt"
              >
                <CalendarIcon />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckSmallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M4.93 19.07l1.41-1.41" />
      <path d="M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c0 .7.4 1.3 1 1.5h.1A2 2 0 1 1 21 14.4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a5 5 0 0 0-5 5v1H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V8a5 5 0 0 0-5-5Z" />
      <path d="M9 9V8a3 3 0 1 1 6 0v1" />
      <path d="M9 15h6" />
    </svg>
  );
}

function ConnectorsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <rect x="6" y="8" width="12" height="6" rx="2" />
      <path d="M12 14v8" />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h16v6H4z" />
      <path d="M4 14h16v6H4z" />
      <path d="M8 7h6" />
      <path d="M8 17h6" />
    </svg>
  );
}

function WorkflowsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="12" cy="18" r="3" />
      <path d="M9 6h6" />
      <path d="M7.5 8.5 11 16" />
      <path d="m16.5 8.5-3.5 7.5" />
    </svg>
  );
}

function ArtifactsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 15h7" />
      <path d="M14 20h5" />
    </svg>
  );
}

function ScheduledIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M3 10h18" />
      <path d="m9 15 2 2 4-4" />
    </svg>
  );
}

function UsageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 16v-5" />
      <path d="M12 16V8" />
      <path d="M16 16v-3" />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
      <path d="M8 9h2" />
    </svg>
  );
}
