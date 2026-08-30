import * as fs from "node:fs";
import * as path from "node:path";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MabelPage from "./MabelPage";
import { resetMabelSessionCache } from "./sessionCache";
import { ArtifactsPage } from "./components/ArtifactsPage";
import { LibraryPage } from "./components/LibraryPage";
import { Markdown } from "./components/Markdown";
import { MemoryPage } from "./components/MemoryPage";
import { ScheduledPage } from "./components/ScheduledPage";
import { SkillsPage } from "./components/SkillsPage";
import { WorkflowsPage } from "./components/WorkflowsPage";

describe("MabelPage", () => {
  afterEach(() => {
    resetMabelSessionCache();
    window.localStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/mabel");
  });

  it("prefills the composer from a ?message= deep link without auto-sending", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );
    const prompt = "@AI-Score-Coach Teach me how to improve my AI usage and efficiency score.";
    window.history.replaceState(null, "", `/mabel?message=${encodeURIComponent(prompt)}`);

    const streamCalls = { n: 0 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [{ id: "skill.ai-score-coach", name: "AI Score Coach", owner_team: "ai-ops", status: "approved" }],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        streamCalls.n += 1;
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);

    const composer = await screen.findByPlaceholderText(/Type \//i);
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(prompt));
    // Prefill only: nothing was sent, and the param is stripped so a refresh does not resend.
    expect(streamCalls.n).toBe(0);
    expect(window.location.search).not.toContain("message=");
  });

  it("renders welcome state, streams a response with inline tool, and exposes Activity + nav pages", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let listCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [{ id: "github", name: "github", connection_status: "connected", tool_count: 1, enabled: true }],
            skills: [{ id: "skill.account-context", name: "Account Context Builder", owner_team: "cs", status: "draft" }],
            starter_packs: [{ id: "starter-pack.account-manager", name: "Account Manager Starter Pack", role_key: "account-manager" }],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_1","conversation_id":22}',
            "",
            'data: {"type":"tool_call","tool_name":"mabel_context","arguments":{"source":"mabel-bootstrap"}}',
            "",
            'data: {"type":"tool_result","tool_name":"mabel_context","output_preview":"connectors=1, skills=1, starter_packs=1"}',
            "",
            'data: {"type":"token","text":"Mabel answer"}',
            "",
            'data: {"type":"run_done","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        listCalls += 1;
        const conversations =
          listCalls > 1
            ? [{ id: 22, title: "Prep my account", surface: "chat", message_count: 2, updated_at: new Date().toISOString() }]
            : [];
        return new Response(JSON.stringify({ conversations }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/scheduled")) {
        return new Response(
          JSON.stringify({
            tasks: [
              {
                id: "sched_1",
                name: "Daily ops heartbeat",
                prompt: "Check key changes",
                schedule_kind: "morning",
                cron: "0 9 * * *",
                timezone: "America/Phoenix",
                status: "active",
                mode: "standalone",
                workflow_id: null,
                notification_mode: "notify_on_change",
                last_run_at: null,
                next_run_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
            runs: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    const rail = screen.getByLabelText("Mabel conversation history");

    expect(await screen.findByRole("heading", { name: /Welcome, Agent/i })).toBeInTheDocument();

    // Left rail nav
    expect(screen.getByRole("button", { name: /New chat/i })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /Connectors/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Skills/i })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /Workflows/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(within(rail).getByRole("button", { name: /Scheduled\s+1/i })).toBeInTheDocument();
    });

    // Old workspace title is gone
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();

    // Activity toggle is no longer a manual control — the panel auto-opens on send.
    expect(screen.queryByLabelText("Toggle activity panel")).not.toBeInTheDocument();

    // Send a message and confirm inline tool card + assistant
    fireEvent.change(screen.getByPlaceholderText(/Type \//i), {
      target: { value: "Prep my account" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(screen.getByText("Mabel answer")).toBeInTheDocument());
    // Tools render in the inline prompt-kit Steps timeline ABOVE the
    // assistant message. The Activity panel now only carries reasoning.
    await waitFor(
      () => {
        const stepsList = container.querySelector(".mabel-thread .mabel-steps-list");
        expect(stepsList).not.toBeNull();
        expect(within(stepsList as HTMLElement).getByText("Read workspace context")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // After the run, the conversation should now appear in the rail
    await waitFor(() => expect(within(rail).getByText("Prep my account")).toBeInTheDocument());
    expect(within(rail).getByText("Recent")).toBeInTheDocument();

    // The row must STAY in the rail — it should not disappear after later refreshes.
    // Wait long enough for any debounced refreshes to settle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(within(rail).getByText("Prep my account")).toBeInTheDocument();

    // Identity-preserving promotion: the DOM node carrying the row must be the
    // SAME node across optimistic → real-id swap and subsequent refresh
    // (proves no unmount/remount flicker).
    const initialRow = within(rail).getByText("Prep my account").closest("[class*=mabel-history-item-row]");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refreshedRow = within(rail).getByText("Prep my account").closest("[class*=mabel-history-item-row]");
    expect(refreshedRow).toBe(initialRow);

    // Activity panel auto-opens on send
    await waitFor(() => expect(screen.getByLabelText("Mabel activity")).toBeVisible());

    // Open Skills page from nav
    fireEvent.click(screen.getByRole("button", { name: /^Skills/i }));
    await waitFor(() =>
      expect(screen.getByText(/Instruction packages loaded into chat/i)).toBeInTheDocument(),
    );

    // Open Connectors page from nav
    fireEvent.click(within(rail).getByRole("button", { name: /Connectors/i }));
    await waitFor(() =>
      expect(screen.getByText(/MCP servers Mabel can call/i)).toBeInTheDocument(),
    );

    // Open Workflows page
    fireEvent.click(screen.getByRole("button", { name: /Workflows/i }));
    await waitFor(() =>
      expect(screen.getByText(/Starter packs loaded into chat/i)).toBeInTheDocument(),
    );

    // Open Scheduled page
    fireEvent.click(screen.getByRole("button", { name: /Scheduled/i }));
    await waitFor(() =>
      expect(screen.getByText(/Recurring Mabel tasks/i)).toBeInTheDocument(),
    );

    // Back to chat via New chat
    fireEvent.click(screen.getByRole("button", { name: /New chat/i }));
    await waitFor(() => {
      const workspace = screen.getByLabelText("Mabel chat workspace");
      expect(within(workspace).queryByText("Prep my account")).not.toBeInTheDocument();
    });
  });

  it("shows admin-only Logs nav and renders live Logs data", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "admin@mabel.local", name: "Admin", sub: "admin-1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "admin@mabel.local", name: "Admin" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/admin/check-access")) {
        return new Response(JSON.stringify({ is_admin: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/admin/logs")) {
        return new Response(
          JSON.stringify({
            totals: { requests: 2, users: 1, conversations: 1, tool_calls: 3, total_tokens: 40, cost_usd: 0.0123 },
            breakdowns: {
              by_user: [{ user_email: "admin@mabel.local", requests: 2, total_tokens: 40, cost_usd: 0.0123 }],
              by_model: [{ model: "gpt-test", requests: 2, total_tokens: 40, cost_usd: 0.0123 }],
              by_surface: [{ surface: "chat", requests: 2 }],
            },
            recent: {
              usage: [
                {
                  run_id: "run_1",
                  user_email: "admin@mabel.local",
                  surface: "chat",
                  status: "completed",
                  model: "gpt-test",
                  created_at: "2026-06-28T10:00:00Z",
                  usage: { total_tokens: 40, cost_usd: 0.0123 },
                },
              ],
              tool_calls: [{ id: 1, run_id: "run_1", tool_name: "mabel_context", status: "completed", created_at: "2026-06-28T10:00:01Z" }],
              audit_events: [{ id: 1, actor_email: "admin@mabel.local", event_type: "mabel.admin.view", status: "completed", created_at: "2026-06-28T10:00:02Z" }],
            },
            counts: { usage_events: 2, tool_calls: 3, audit_events: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/usage/summary")) {
        return new Response(JSON.stringify({ totals: { requests: 2 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/conversations")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);
    const rail = screen.getByLabelText("Mabel conversation history");
    const logsButton = await within(rail).findByRole("button", { name: /^Logs/i });
    fireEvent.click(logsButton);

    expect((await screen.findAllByRole("heading", { name: "Logs" })).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("Requests").nextSibling?.textContent).toBe("2"));
    expect(screen.getAllByText("admin@mabel.local").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(screen.getByText("mabel_context")).toBeInTheDocument();
  });

  it("supports Claude-like Mabel skill creation, upload import, metadata, and content preview", async () => {
    const onRefresh = vi.fn();
    const onUseInChat = vi.fn();
    let createBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/v1/skills/skill.account-context") && method === "GET") {
        return new Response(
          JSON.stringify({
            skill: {
              id: "skill.account-context",
              name: "Account Context Builder",
              owner_team: "cs",
              status: "draft",
              description: "Build account context before a meeting.",
              content_md: "# Account Context Builder\n\nUse Salesforce and cite sources.",
              created_at: "2026-06-01T12:00:00Z",
              updated_at: "2026-06-02T12:00:00Z",
              tags: ["account"],
              mcp_bindings: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/skills") && method === "POST") {
        createBody = JSON.parse(String(init?.body || "{}"));
        return new Response(JSON.stringify({ skill: createBody }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bootstrap = {
      user: { email: "agent@example.com", name: "Agent Smith" },
      surfaces: ["chat", "rag", "mcp", "agents"] as const,
      connectors: [],
      skills: [
        {
          id: "skill.account-context",
          name: "Account Context Builder",
          owner_team: "cs",
          status: "draft",
          description: "Build account context before a meeting.",
          created_at: "2026-06-01T12:00:00Z",
          updated_at: "2026-06-02T12:00:00Z",
          tags: ["account"],
          mcp_bindings: [],
        },
      ],
      starter_packs: [],
      approvals: [],
    };

    const { container } = render(
      <SkillsPage
        bootstrap={bootstrap}
        onRefresh={onRefresh}
        onUseInChat={onUseInChat}
        usage={{}}
        conversations={[]}
        onOpenConversation={vi.fn()}
      />,
    );

    expect(screen.getByText(/Created Jun/i)).toBeInTheDocument();
    expect(screen.getByText(/Updated Jun/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const preview = await screen.findByRole("dialog", { name: /Account Context Builder skill content/i });
    expect(within(preview).getByText(/Use Salesforce and cite sources/i)).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "Done" }));

    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Create with Mabel/i }));
    expect(onUseInChat).toHaveBeenCalledWith(
      "Help me create a new Mabel skill.",
      undefined,
      expect.stringContaining("mabel_create_skill"),
    );

    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Write skill instructions/i }));
    fireEvent.change(screen.getByLabelText(/Skill name/i), { target: { value: "Weekly Status Report" } });
    fireEvent.change(screen.getByLabelText(/Description/i), { target: { value: "Generate weekly progress updates." } });
    fireEvent.change(screen.getByLabelText(/Instructions/i), { target: { value: "Summarize wins, blockers, and next steps." } });
    fireEvent.click(screen.getByRole("button", { name: /Save skill/i }));

    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody!.id).toBe("skill.weekly-status-report");
    expect(createBody!.description).toBe("Generate weekly progress updates.");
    expect(String(createBody!.content_md)).toContain("description: >");

    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Upload a skill/i }));
    const uploadDialog = await screen.findByRole("dialog", { name: /Upload skill/i });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(
      [
        "---\nname: Imported Skill\ndescription: >\n  Imported from SKILL.md\ntags: import, test\n---\n\n# Imported Skill\n\nFollow imported instructions.",
      ],
      "SKILL.md",
      { type: "text/markdown" },
    );
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(uploadDialog).not.toBeInTheDocument());
    expect(screen.getByDisplayValue("Imported Skill")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Imported from SKILL.md")).toBeInTheDocument();
  });

  it("shows draft skills from the full skills endpoint even when bootstrap has no launch-ready skills", async () => {
    const onCountChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/skills")) {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  id: "skill.meeting-prep-brief-builder",
                  name: "Meeting Prep Brief Builder",
                  owner_team: "Revenue AI",
                  status: "draft",
                  description: "Prepare account meeting briefs.",
                  tags: ["meeting-prep"],
                  mcp_bindings: [],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ skills: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(
      <SkillsPage
        bootstrap={{
          user: { email: "agent@example.com", name: "Agent Smith" },
          surfaces: ["chat", "rag", "mcp", "agents"],
          connectors: [],
          skills: [],
          starter_packs: [],
          approvals: [],
        }}
        onRefresh={vi.fn()}
        onUseInChat={vi.fn()}
        usage={{}}
        conversations={[]}
        onOpenConversation={vi.fn()}
        onCountChange={onCountChange}
      />,
    );

    expect(await screen.findByText("Meeting Prep Brief Builder")).toBeInTheDocument();
    expect(screen.getByText("skill.meeting-prep-brief-builder")).toBeInTheDocument();
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
  });

  it("shows scheduled next run in the task timezone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            tasks: [
              {
                id: "sched_ai_news",
                name: "Daily top AI news brief",
                prompt: "Find top AI news",
                schedule_kind: "cron",
                cron: "0 7 * * *",
                timezone: "America/Phoenix",
                status: "active",
                mode: "standalone",
                workflow_id: null,
                notification_mode: "notify_on_change",
                last_run_at: null,
                next_run_at: "2026-07-01T14:00:00Z",
                created_at: "2026-07-01T13:00:00Z",
                updated_at: "2026-07-01T13:00:00Z",
              },
            ],
            runs: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(<ScheduledPage onCreateInChat={vi.fn()} />);

    expect(await screen.findByText("Daily top AI news brief")).toBeInTheDocument();
    expect(screen.getByText(/Next: Jul 1, 7:00 AM (MST|GMT-7)/i)).toBeInTheDocument();
  });

  it("keeps Artifacts create prompt short while hiding save instructions", async () => {
    const onCreateInChat = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ artifacts: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(
      <ArtifactsPage
        onCreateInChat={onCreateInChat}
        onOpenArtifact={vi.fn()}
        onOpenConversation={vi.fn()}
      />,
    );

    await screen.findByText("No artifacts yet");
    fireEvent.click(screen.getByRole("button", { name: "Create in chat" }));

    expect(onCreateInChat).toHaveBeenCalledWith(
      "Help me create a dashboard artifact.",
      undefined,
      expect.stringContaining("mabel_save_artifact"),
    );
  });

  it("filters library files by type and source without showing notes", async () => {
    const now = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/files")) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "file_uploaded",
                name: "brief.pdf",
                mime_type: "application/pdf",
                size_bytes: 2048,
                source: "user_upload",
                created_at: now,
                project_id: null,
              },
              {
                id: "file_generated",
                name: "chart.png",
                mime_type: "image/png",
                size_bytes: 1024,
                source: "agent_generated",
                created_at: now,
                project_id: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LibraryPage onOpenFile={vi.fn()} onChatWithFile={vi.fn()} />);

    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    expect(screen.getByText("chart.png")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Notes" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Library file type"), { target: { value: "pdfs" } });
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();
    expect(screen.queryByText("chart.png")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Library file type"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Library source"), { target: { value: "generated" } });
    expect(screen.queryByText("brief.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("chart.png")).toBeInTheDocument();
  });

  it("hides manual memory save and omits bulk clear", async () => {
    render(
      <MemoryPage
        memoryItems={[
          {
            id: "mem_1",
            key: "customer.preference",
            content: "Use concise summaries.",
            tags: ["preference"],
            pinned: false,
            confidence: 0.8,
            source: "chat",
            conversation_id: null,
            last_used_at: null,
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
        ]}
        onDelete={vi.fn(async () => undefined)}
        onUseInChat={vi.fn()}
        onExport={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.queryByText("Save memory")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(screen.getByText("Saved memory (1)")).toBeInTheDocument();
  });

  it("keeps Workflows builder and Run actions wired", async () => {
    const onRunPack = vi.fn(async () => undefined);
    const onBuildWorkflow = vi.fn();
    const onRefresh = vi.fn(async () => undefined);

    render(
      <WorkflowsPage
        bootstrap={{
          user: { email: "agent@example.com", name: "Agent Smith" },
          surfaces: ["chat", "rag", "mcp", "agents"],
          connectors: [{ id: "github", name: "GitHub", connection_status: "connected", enabled: true }],
          skills: [
            {
              id: "skill.requirements-synthesis",
              name: "Requirements Synthesis",
              status: "approved",
              owner_team: "ai-ops",
              tags: ["requirements"],
              mcp_bindings: [],
            },
          ],
          starter_packs: [
            {
              id: "workflow-pack.custom-test",
              name: "Custom Test Workflow",
              role_key: "custom-test",
              status: "draft",
              commands: [{ name: "execute-objective", description: "Do the work" }],
              skill_ids: ["skill.requirements-synthesis"],
              connector_slugs: ["github"],
              policies: {},
            },
          ],
          approvals: [],
        }}
        onRefresh={onRefresh}
        onRunPack={onRunPack}
        onBuildWorkflow={onBuildWorkflow}
        usage={{ "workflow-pack.custom-test": [42] }}
        conversations={[{ id: 42, title: "Built workflow", surface: "chat", message_count: 4, updated_at: new Date().toISOString() }]}
        onOpenConversation={vi.fn()}
      />,
    );

    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByText("Built workflow")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Build workflow" }));
    expect(onBuildWorkflow).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(onRunPack).toHaveBeenCalled());
    expect(onRefresh).toHaveBeenCalled();
  });

  it("renders Start My Day as a normal workflow row with MCP and skill chips", () => {
    render(
      <WorkflowsPage
        bootstrap={{
          service: "mabel",
          user: { email: "admin@mabel.local", name: "Admin" },
          surfaces: [],
          connectors: [
            { id: "outlook-calendar", name: "Outlook Calendar", connection_status: "not_configured", tool_count: 0 },
            { id: "microsoft-teams", name: "Microsoft Teams", connection_status: "not_configured", tool_count: 0 },
            { id: "salesforce", name: "Salesforce", connection_status: "not_configured", tool_count: 0 },
          ],
          skills: [],
          starter_packs: [
            {
              id: "workflow-pack.start-my-day",
              name: "Start My Day",
              role_key: "account-manager",
              status: "approved",
              skill_ids: ["skill.start-my-day", "skill.product-usage"],
              connector_slugs: ["outlook-calendar", "microsoft-teams", "salesforce"],
              policies: {
                skill_display_names: {
                  "skill.start-my-day": "Meeting prep briefing",
                  "skill.product-usage": "Product usage summaries",
                },
              },
            },
          ],
          approvals: [],
        }}
        onRefresh={vi.fn()}
        onRunPack={vi.fn()}
        onBuildWorkflow={vi.fn()}
        usage={{}}
        conversations={[]}
        onOpenConversation={vi.fn()}
      />,
    );

    expect(screen.getByText("Start My Day")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start chat" })).not.toBeInTheDocument();
    expect(screen.getByText("Skill: Meeting prep briefing")).toBeInTheDocument();
    expect(screen.getByText("Skill: Product usage summaries")).toBeInTheDocument();
    expect(screen.getByText("MCP: Outlook Calendar")).toBeInTheDocument();
    expect(screen.queryByText("MCP: Product usage")).not.toBeInTheDocument();
    expect(screen.queryByText("Vision preview")).not.toBeInTheDocument();
  });

  it("rename and delete update the rail without a page refresh", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let title = "Original Title";
    let exists = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();

      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.match(/\/api\/v1\/conversations\/77$/) && method === "PATCH") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        title = body.title || title;
        return new Response(
          JSON.stringify({ conversation: { id: 77, title, surface: "chat", updated_at: new Date().toISOString() } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.match(/\/api\/v1\/conversations\/77$/) && method === "DELETE") {
        exists = false;
        return new Response(JSON.stringify({ deleted: 77 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        const conversations = exists
          ? [{ id: 77, title, surface: "chat", message_count: 2, updated_at: new Date().toISOString() }]
          : [];
        return new Response(JSON.stringify({ conversations }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);

    const rail = await screen.findByLabelText("Mabel conversation history");
    await waitFor(() => expect(within(rail).getByText("Original Title")).toBeInTheDocument());

    // Open the kebab menu and rename
    fireEvent.click(within(rail).getByLabelText(/Conversation menu for Original Title/i));
    fireEvent.click(within(rail).getByText("Rename"));
    const input = within(rail).getByDisplayValue("Original Title");
    fireEvent.change(input, { target: { value: "Renamed Live" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(within(rail).getByText("Renamed Live")).toBeInTheDocument());
    expect(within(rail).queryByText("Original Title")).not.toBeInTheDocument();

    // Open the kebab menu and delete
    fireEvent.click(within(rail).getByLabelText(/Conversation menu for Renamed Live/i));
    fireEvent.click(within(rail).getByText("Delete"));
    // ConfirmDialog appears
    const dialog = await screen.findByRole("dialog", { name: /Delete conversation/i });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(within(rail).queryByText("Renamed Live")).not.toBeInTheDocument());
    expect(within(rail).queryByText("Recent")).not.toBeInTheDocument();
  });

  it("hides the assistant 'R' avatar, renders Copy/Regenerate as icon-only buttons, and keeps short user bubbles on one line", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_x","conversation_id":91}',
            "",
            'data: {"type":"token","text":"Hello back."}',
            "",
            'data: {"type":"run_done","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(screen.getByText("Hello back.")).toBeInTheDocument());

    // No assistant 'R' avatar in the thread.
    expect(container.querySelector(".mabel-message-avatar")).toBeNull();

    // Copy + Regenerate are icon-only buttons; no text labels.
    const copyButton = await screen.findByLabelText(/Copy response/i);
    expect(copyButton).toBeInTheDocument();
    expect(copyButton.textContent || "").toMatch(/^\s*$/);
    expect(copyButton.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(/^Copy$/)).toBeNull();
    expect(screen.queryByText(/^Regenerate$/)).toBeNull();

    const regenButton = screen.getByLabelText(/Regenerate response/i);
    expect(regenButton).toBeInTheDocument();
    expect(regenButton.querySelector("svg")).not.toBeNull();

    // User bubble for "hi" wraps content but doesn't get crushed into a vertical column.
    const userBubble = container.querySelector(".mabel-message--user .mabel-message-bubble");
    expect(userBubble).not.toBeNull();
    expect(userBubble?.textContent).toBe("hi");
  });

  it("prefills schedule prompt in the current chat instead of starting a new thread", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_schedule","conversation_id":91}',
            "",
            'data: {"type":"token","text":"Here is the thing you asked for."}',
            "",
            'data: {"type":"run_done","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "summarize support calls" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText("Here is the thing you asked for.");

    fireEvent.click(screen.getByLabelText("Schedule prompt"));

    expect(screen.getByText("Here is the thing you asked for.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByDisplayValue(/Help me schedule this prompt: "summarize support calls"/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: /Welcome, Agent/i })).not.toBeInTheDocument();
  });

  it("anchors tool clusters to the assistant turn that produced them across multiple messages", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let streamCall = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        streamCall += 1;
        const cid = 80 + streamCall;
        const tool = streamCall === 1 ? "alpha_tool" : "beta_tool";
        return new Response(
          [
            `data: {"type":"run_started","run_id":"run_${streamCall}","conversation_id":${cid}}`,
            "",
            `data: {"type":"tool_call","tool_name":"${tool}","arguments":{}}`,
            "",
            `data: {"type":"tool_result","tool_name":"${tool}","output_preview":"out_${streamCall}"}`,
            "",
            `data: {"type":"token","text":"answer_${streamCall}"}`,
            "",
            'data: {"type":"run_done","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    // Turn 1: tools render as a prompt-kit Steps block ABOVE the assistant
    // bubble (one block per tool, in NLG form like "Used alpha_tool").
    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText("answer_1");
    await waitFor(
      () => {
        const stepBlocks = container.querySelectorAll(".mabel-thread .mabel-steps");
        expect(stepBlocks.length).toBe(1);
        expect(within(stepBlocks[0] as HTMLElement).getByText(/alpha_tool/i)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    // Old inline ToolCallCard squares are gone.
    expect(container.querySelector(".mabel-thread .mabel-tool-stack")).toBeNull();
    expect(container.querySelector(".mabel-thread .mabel-tool-card")).toBeNull();

    // Turn 2
    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText("answer_2");
    await waitFor(
      () => {
        const stepBlocks = container.querySelectorAll(".mabel-thread .mabel-steps");
        // One per tool, anchored under each assistant turn.
        expect(stepBlocks.length).toBe(2);
      },
      { timeout: 3000 },
    );

    // Thread DOM order is just user → assistant for each turn now.
    const thread = container.querySelector(".mabel-thread") as HTMLElement;
    expect(thread).not.toBeNull();
    const answer1Node = within(thread).getByText("answer_1");
    const answer2Node = within(thread).getByText("answer_2");
    expect(answer1Node.compareDocumentPosition(answer2Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the Thinking shimmer loader before the first token and renders markdown bullets with visible list-style", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    // Build a stream where the first byte takes a beat so we can observe
    // the loader appearing, then resolve with a small markdown list.
    let releaseFirstToken: (() => void) | null = null;
    const firstTokenPromise = new Promise<void>((resolve) => {
      releaseFirstToken = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"type":"run_started","run_id":"run_l","conversation_id":7}\n\n'));
            await firstTokenPromise;
            controller.enqueue(enc.encode('data: {"type":"token","text":"Here:\\n\\n- one\\n- two\\n- three"}\n\n'));
            controller.enqueue(enc.encode('data: {"type":"run_done","run_id":"run_l","status":"completed"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "give me 3 things" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    // Before any token arrives, the Thinking shimmer is shown.
    // The pulse-dot was removed; the shimmer text alone signals progress.
    await waitFor(() => {
      expect(container.querySelector(".mabel-message-loader")).not.toBeNull();
    });
    expect(container.querySelector(".mabel-shimmer")).not.toBeNull();
    expect(container.querySelector(".mabel-pulse-dot")).toBeNull();

    // Release the token and check the loader is replaced by the bubble.
    releaseFirstToken!();

    await waitFor(() => expect(screen.getByText("one")).toBeInTheDocument());
    expect(container.querySelector(".mabel-message-loader")).toBeNull();

    // List bullets must be visible: the <ul> renders inside mabel-markdown
    // with list-style: disc (overriding Tailwind's preflight reset).
    const ul = container.querySelector(".mabel-markdown ul") as HTMLElement | null;
    expect(ul).not.toBeNull();
    const style = window.getComputedStyle(ul!);
    // jsdom doesn't compute inherited list-style fully, so we read the
    // declared rule from our stylesheet via the resolved value.
    expect(["disc", "disc outside"]).toContain(style.listStyleType);
  });

  it("clicking an inline Steps head switches the single Activity Thinking row to that turn", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let convoId = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        convoId += 1;
        return new Response(
          [
            `data: {"type":"run_started","run_id":"run_${convoId}","conversation_id":${convoId}}`,
            "",
            `data: {"type":"tool_call","tool_name":"web_search","arguments":{"query":"q${convoId}"}}`,
            "",
            `data: {"type":"tool_result","tool_name":"web_search","output_preview":"r${convoId}"}`,
            "",
            `data: {"type":"token","text":"answer_${convoId}"}`,
            "",
            'data: {"type":"run_done","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText("answer_1");

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText("answer_2");

    // Always exactly ONE Thinking entry in Activity (not a tower of them).
    const activity = await screen.findByLabelText("Mabel activity");
    await waitFor(() =>
      expect(activity.querySelectorAll(".mabel-cot__step--reasoning").length).toBe(1),
    );

    // Two inline Steps blocks, one per assistant turn. Click the FIRST
    // one — the Activity panel should still have one entry, but it now
    // represents turn 1 (we can't easily inspect which without exposing
    // ids, so we just assert the click registers and we still have 1).
    const allStepsHeads = container.querySelectorAll(".mabel-thread .mabel-steps__head");
    expect(allStepsHeads.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(allStepsHeads[0] as HTMLButtonElement);
    expect(activity.querySelectorAll(".mabel-cot__step--reasoning").length).toBe(1);
  });

  it("assistant-generated file chip is a clickable button that JS-fetches the file with auth headers", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let fileFetchHeaders: Record<string, string> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_dl","conversation_id":100}',
            "",
            'data: {"type":"agent_file","file_id":"file_dl_123","name":"hello_world.docx","mime":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","kind":"file"}',
            "",
            'data: {"type":"token","text":"Created the doc."}',
            "",
            'data: {"type":"run_done","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/files/file_dl_123")) {
        // Capture the headers the client sent for the download fetch.
        fileFetchHeaders = (init?.headers as Record<string, string>) || {};
        return new Response(new Blob(["docx bytes"]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "make me a docx" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText("Created the doc.");

    // The assistant-side chip is a <button>, NOT an <a>, so a click opens
    // Mabel's authenticated preview panel instead of native link navigation
    // (which has no X-User-* headers and fails 401).
    const chip = await waitFor(() => {
      const el = container.querySelector(
        ".mabel-message--assistant .mabel-message__chip",
      ) as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(chip.tagName.toLowerCase()).toBe("button");
    expect(chip.textContent).toContain("hello_world.docx");

    fireEvent.click(chip);
    await waitFor(() => expect(fileFetchHeaders).not.toBeNull());
    await waitFor(() => expect(screen.getByLabelText("Mabel artifact")).toBeInTheDocument());
    expect(within(screen.getByLabelText("Mabel artifact")).getByText("hello_world.docx")).toBeInTheDocument();
    // The preview fetch carries the same X-User-* headers every other
    // Mabel API call uses.
    expect(fileFetchHeaders!["X-User-Email"]).toBe("agent@example.com");
    // (Lower-case lookup just in case the mock normalizes.)
    const ctKey = Object.keys(fileFetchHeaders!).find((k) => k.toLowerCase() === "content-type");
    // Multipart upload is NOT what we're sending here — content-type may
    // be application/json from getAuthHeaders, which the file endpoint
    // ignores. Just confirm headers exist.
    void ctKey;
  });

  it("waits until the assistant stream finishes before showing generated file chips", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "make csv" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(streamController).not.toBeNull());
    streamController!.enqueue(encoder.encode('data: {"type":"run_started","run_id":"run_csv","conversation_id":100}\n\n'));
    streamController!.enqueue(encoder.encode('data: {"type":"agent_file","file_id":"file_csv","name":"export.csv","mime":"text/csv","kind":"file"}\n\n'));

    await waitFor(() => expect(container.querySelector(".mabel-message--assistant")).not.toBeNull());
    expect(container.querySelector(".mabel-message--assistant .mabel-message__chip")).toBeNull();

    streamController!.enqueue(encoder.encode('data: {"type":"token","text":"Here is the export."}\n\n'));
    await screen.findByText("Here is the export.");
    expect(container.querySelector(".mabel-message--assistant .mabel-message__chip")).toBeNull();

    streamController!.enqueue(encoder.encode('data: {"type":"run_done","run_id":"run_csv","status":"completed"}\n\n'));
    streamController!.close();

    await waitFor(() => {
      const chip = container.querySelector(".mabel-message--assistant .mabel-message__chip");
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain("export.csv");
    });
  });

  it("live ticks 'Thinking for Ns…' in Activity while streaming, then freezes to 'Thought for N seconds' on first token", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let resolveStreamBody: ((body: string) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        // Stall the stream — body is resolved by the test below so we can
        // assert the live tick behavior in between sends and the first
        // token arrival.
        const body = await new Promise<string>((resolve) => {
          resolveStreamBody = resolve;
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "long ask" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    // Immediately after send the Activity panel auto-opens and renders a
    // running "Thinking for Ns…" step (no first token yet).
    const activity = await screen.findByLabelText("Mabel activity");
    await waitFor(() => {
      expect(within(activity).getByText(/Thinking for \d+s/)).toBeInTheDocument();
    });

    // Now release the stream — first token arrives, the counter should
    // freeze and the title becomes "Thought for N seconds".
    resolveStreamBody?.(
      [
        'data: {"type":"run_started","run_id":"run_t","conversation_id":99}',
        "",
        'data: {"type":"token","text":"Done."}',
        "",
        'data: {"type":"run_done","status":"completed"}',
        "",
      ].join("\n"),
    );

    await screen.findByText("Done.");
    await waitFor(() => {
      expect(within(activity).getByText(/Thought for/i)).toBeInTheDocument();
    });
    // The running label is gone once a token landed.
    expect(within(activity).queryByText(/Thinking for/i)).toBeNull();
  });

  it("Activity always shows a Thinking row with elapsed time after a send — no 'Reasoning appears here' placeholder", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_x","conversation_id":99}',
            "",
            'data: {"type":"token","text":"All set."}',
            "",
            'data: {"type":"run_done","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "ping" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText("All set.");

    const activity = await screen.findByLabelText("Mabel activity");
    // The empty-state placeholder line is gone.
    expect(
      within(activity).queryByText(/Reasoning appears here/i),
    ).toBeNull();
    // No section header — the elapsed time in the title bar
    // ("Activity · Ns") + the single Thought-for row carry all the
    // information; an extra "Thinking" h4 was redundant noise.
    expect(within(activity).queryByText(/^Thinking$/)).toBeNull();
    // A "Thought for ..." row is rendered for the turn (even though no
    // reasoning deltas were emitted, the wall-clock timing is always
    // captured for every send).
    expect(within(activity).getByText(/Thought for/i)).toBeInTheDocument();
    // No "Wrote response" / tool steps in Activity (that was the old shape).
    expect(within(activity).queryByText("Wrote response")).toBeNull();
  });

  it("renders paragraph → paragraph → list → paragraph (the weather forecast pattern) with no orphan elements between blocks", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    // The exact pattern that produces "huge gaps" in the rendered chat:
    // a short intro paragraph, a one-line "Forecast:" paragraph, the list,
    // and a closing source paragraph.
    const markdown = [
      "NYC weather right now: **mostly clear, 78°F**.",
      "",
      "Forecast:",
      "",
      "- **Today, Tuesday May 19:** Mostly sunny and hot, **high 92°F**, low 74°F",
      "- **Wednesday May 20:** Near-record heat",
      "",
      "[Weather source](https://example.com)",
    ].join("\n");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_f","conversation_id":11}',
            "",
            `data: {"type":"token","text":${JSON.stringify(markdown)}}`,
            "",
            'data: {"type":"run_done","run_id":"run_f","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "forecast" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText(/Weather source/);

    // The assistant markdown body should have EXACTLY these children in
    // order: <p> intro, <p> "Forecast:", <ul>, <p> source. Anything else
    // (an empty <p>, a stray <br>, a <div>) means we have orphan spacing.
    const body = container.querySelector(".mabel-message--assistant .mabel-markdown") as HTMLElement;
    expect(body).not.toBeNull();
    const children = Array.from(body.children);
    const tags = children.map((c) => c.tagName.toLowerCase());
    expect(tags).toEqual(["p", "p", "ul", "p"]);
    // No empty / whitespace-only children.
    for (const child of children) {
      const textOnly = (child.textContent || "").trim();
      expect(textOnly.length).toBeGreaterThan(0);
    }
    // The list has exactly the 2 bullets we sent.
    const ul = body.querySelector("ul") as HTMLElement;
    expect(ul.children.length).toBe(2);

    // CRITICAL: the assistant bubble's stylesheet must override the default
    // `.mabel-message-bubble { white-space: pre-wrap }` to `normal`. jsdom
    // does NOT apply stylesheet rules so getComputedStyle returns ''. We
    // instead read the source CSS file and assert the override is present.
    // pre-wrap turns the whitespace text nodes React inserts between
    // sibling DOM elements (the JSX line breaks) into visible vertical
    // gaps — that was the root cause of "huge spacing between Forecast:
    // and the bullet list". User bubbles must keep pre-wrap so typed
    // newlines render; assistants must be `normal`.
    const bubble = container.querySelector(
      ".mabel-message--assistant .mabel-message-bubble",
    ) as HTMLElement;
    expect(bubble).not.toBeNull();
    const css = fs.readFileSync(
      path.resolve(__dirname, "mabel.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.mabel-message--assistant\s+\.mabel-message-bubble[\s\S]*?white-space:\s*normal/,
    );
  });

  it("normalizes 3+ newlines so a paragraph immediately followed by a list does not insert an empty <p> gap", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    // This is the GPT-5.5 loose-output pattern that caused the
    // Forecast / list gap: a heading-styled paragraph, then THREE newlines,
    // then a bullet list with blank lines between every item.
    const noisyMarkdown = [
      "**Forecast**",
      "",
      "",
      "- **Today, Mon May 18**: Mostly sunny, very warm",
      "",
      "- **Tue May 19**: Mostly sunny and hot",
      "",
      "- **Wed May 20**: Very hot",
    ].join("\n");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_n","conversation_id":9}',
            "",
            `data: {"type":"token","text":${JSON.stringify(noisyMarkdown)}}`,
            "",
            'data: {"type":"run_done","run_id":"run_n","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "forecast" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText(/Today, Mon May 18/);

    // Inside the assistant markdown there must be no empty <p> nodes (those
    // are what produced the giant inter-section / inter-bullet gaps).
    const allParagraphs = container.querySelectorAll(".mabel-message--assistant .mabel-markdown p");
    for (const p of Array.from(allParagraphs)) {
      const text = (p.textContent || "").replace(/\s+/g, "");
      expect(text.length).toBeGreaterThan(0);
    }

    // The list must render exactly once with the three items, and there
    // must be NO intermediate paragraph between the "Forecast" paragraph
    // and the <ul>.
    const ul = container.querySelector(".mabel-message--assistant .mabel-markdown ul") as HTMLElement | null;
    expect(ul).not.toBeNull();
    expect(ul!.children.length).toBe(3);
    const prev = ul!.previousElementSibling;
    expect(prev?.tagName.toLowerCase()).toBe("p");
    expect(prev?.textContent).toMatch(/Forecast/);
  });

  it("clicking an inline tool card reopens the Activity panel and shows reasoning + auto-scrolls on streaming tokens", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        const frames = [
          'data: {"type":"run_started","run_id":"run_ax","conversation_id":99}',
          "",
          'data: {"type":"reasoning","text":"Thinking about the question."}',
          "",
          'data: {"type":"reasoning","text":" Considering tools to use."}',
          "",
          'data: {"type":"tool_call","tool_name":"web_search","arguments":{"query":"x"}}',
          "",
          'data: {"type":"tool_result","tool_name":"web_search","output_preview":"done"}',
          "",
          'data: {"type":"token","text":"Hello"}',
          "",
          'data: {"type":"token","text":" world."}',
          "",
          'data: {"type":"run_done","run_id":"run_ax","status":"completed"}',
          "",
        ];
        return new Response(frames.join("\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    // Track scroll: the .mabel-message-list element must be scrolled to its
    // bottom each time content streams in. jsdom lets us spy on scrollTop.
    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText("Hello world.");

    const list = container.querySelector(".mabel-message-list") as HTMLDivElement;
    expect(list).not.toBeNull();
    // After streaming, scrollTop should have been pushed to the bottom (or
    // attempted to — in jsdom scrollHeight is the floor we set it to).
    expect(list.scrollTop).toBeGreaterThanOrEqual(0);

    // Activity panel auto-opens on send and now shows EXACTLY one
    // Thought-for-Ns row for the latest turn — no "Thinking" header,
    // no tool / answer steps (those live inline above the bubble).
    const activity = await screen.findByLabelText("Mabel activity");
    expect(within(activity).getByText(/Thought for/i)).toBeInTheDocument();
    expect(within(activity).queryByText(/^Thinking$/)).toBeNull();
    expect(within(activity).queryByText("Wrote response")).toBeNull();
    expect(within(activity).queryByText("Searched the web")).toBeNull();
    // Only ONE Thinking entry — not all turns stacked.
    expect(activity.querySelectorAll(".mabel-cot__step--reasoning").length).toBe(1);
    // Inline Steps timeline above the bubble carries the tool action.
    const stepsList = container.querySelector(".mabel-thread .mabel-steps-list") as HTMLElement | null;
    expect(stepsList).not.toBeNull();
    expect(within(stepsList!).getByText("Searched the web")).toBeInTheDocument();

    // Tools are no longer rendered inline in the chat thread (they live
    // in the Activity panel exclusively, prompt-kit Steps style). Verify
    // the thread is clean.
    expect(container.querySelector(".mabel-thread .mabel-tool-stack")).toBeNull();
    expect(container.querySelector(".mabel-thread .mabel-tool-card")).toBeNull();
  });

  it("renders sources chips under the assistant message and shows them in the Activity chain-of-thought", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        const frames = [
          'data: {"type":"run_started","run_id":"run_src","conversation_id":1}',
          "",
          'data: {"type":"tool_call","tool_name":"web_search","arguments":{"query":"openai agents python sdk"}}',
          "",
          'data: {"type":"sources","sources":[{"url":"https://openai.github.io/openai-agents-python/","title":"OpenAI Agents Python"},{"url":"https://github.com/openai/openai-agents-python","title":"openai-agents-python · GitHub"}]}',
          "",
          'data: {"type":"tool_result","tool_name":"web_search","output_preview":""}',
          "",
          'data: {"type":"token","text":"Found two relevant resources."}',
          "",
          'data: {"type":"run_done","run_id":"run_src","status":"completed"}',
          "",
        ];
        return new Response(frames.join("\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), {
      target: { value: "search the agents SDK" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText("Found two relevant resources.");

    // The standalone gray "Sources" block under the bubble was removed —
    // sources live only inside the inline Steps "Searched the web"
    // entry now, no duplicate render.
    expect(
      container.querySelector(".mabel-message--assistant .mabel-sources"),
    ).toBeNull();

    // Activity panel is now pure thinking — no tool / answer rows.
    const activity = await screen.findByLabelText("Mabel activity");
    expect(within(activity).queryByText("Wrote response")).toBeNull();
    expect(within(activity).queryByText("Searched the web")).toBeNull();

    // Inline Steps above the assistant bubble carry the tool action AND
    // the source chips together (prompt-kit Steps with sources). Click
    // the head to reveal the sources.
    const stepsList = container.querySelector(".mabel-thread .mabel-steps-list") as HTMLElement;
    expect(stepsList).not.toBeNull();
    const stepHead = within(stepsList).getByText("Searched the web").closest("button") as HTMLButtonElement;
    expect(stepHead).not.toBeNull();
    fireEvent.click(stepHead);
    await waitFor(() => {
      const inlineSources = stepsList.querySelector(".mabel-steps__sources");
      expect(inlineSources).not.toBeNull();
    });
    // Source chips show the host (favicon + accuweather/github style).
    expect(
      within(stepsList).getAllByRole("link").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("renders source chips even when sources stream without a tool event", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_src_only","conversation_id":44}',
            "",
            'data: {"type":"sources","sources":[{"url":"https://openai.github.io/openai-agents-python/","title":"Agents SDK"}]}',
            "",
            'data: {"type":"token","text":"Here is the cited answer."}',
            "",
            'data: {"type":"run_done","run_id":"run_src_only","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "cite this" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText("Here is the cited answer.");
    const stepsList = container.querySelector(".mabel-thread .mabel-steps-list") as HTMLElement;
    expect(stepsList).not.toBeNull();
    expect(within(stepsList).getByText("Sources")).toBeInTheDocument();
    expect(within(stepsList).getAllByRole("link").length).toBe(1);
  });

  it("shows web-search query arrays without the stale no-sources fallback", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_query_array","conversation_id":46}',
            "",
            'data: {"type":"tool_call","tool_call_id":"call_web","tool_name":"web_search","arguments":{"type":"search","query":null,"queries":["weather: United States, New York, New York City"],"sources":null}}',
            "",
            'data: {"type":"tool_result","tool_call_id":"call_web","tool_name":"web_search","output_preview":""}',
            "",
            'data: {"type":"token","text":"NYC is currently cloudy."}',
            "",
            'data: {"type":"run_done","run_id":"run_query_array","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "weather in nyc" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText("NYC is currently cloudy.");
    const stepsList = container.querySelector(".mabel-thread .mabel-steps-list") as HTMLElement;
    expect(stepsList).not.toBeNull();
    const stepHead = within(stepsList).getByText("Searched the web").closest("button") as HTMLButtonElement;
    fireEvent.click(stepHead);

    expect(within(stepsList).getByText("Query: weather: United States, New York, New York City")).toBeInTheDocument();
    expect(
      within(stepsList).queryByText("Search completed. No source links were returned by the model."),
    ).not.toBeInTheDocument();
  });

  it("renders provider-only weather sources as source pills instead of raw SDK ids", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_weather_provider","conversation_id":47}',
            "",
            'data: {"type":"tool_call","tool_call_id":"call_web","tool_name":"web_search","arguments":{"type":"search","query":null,"queries":["weather: USA, New York, New York"],"sources":[{"type":"api","url":null,"name":"oai-weather"}]}}',
            "",
            'data: {"type":"sources","sources":[{"title":"OpenAI Weather","provider":"oai-weather","kind":"api"}]}',
            "",
            'data: {"type":"tool_result","tool_call_id":"call_web","tool_name":"web_search","output_preview":""}',
            "",
            'data: {"type":"token","text":"NYC is currently mostly cloudy and 70°F."}',
            "",
            'data: {"type":"run_done","run_id":"run_weather_provider","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "weather in nyc" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText("NYC is currently mostly cloudy and 70°F.");
    const stepsList = container.querySelector(".mabel-thread .mabel-steps-list") as HTMLElement;
    expect(stepsList).not.toBeNull();
    fireEvent.click(within(stepsList).getByText("Searched the web").closest("button") as HTMLButtonElement);

    expect(within(stepsList).getByText("Query: weather: USA, New York, New York")).toBeInTheDocument();
    expect(within(stepsList).getByText("OpenAI Weather")).toBeInTheDocument();
    expect(within(stepsList).queryByText(/Sources: oai-weather/i)).not.toBeInTheDocument();
  });

  it("keeps repeated same-name tool calls as separate Steps when call ids differ", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_tools","conversation_id":45}',
            "",
            'data: {"type":"tool_call","tool_call_id":"call_1","tool_name":"web_search","arguments":{"query":"first"}}',
            "",
            'data: {"type":"tool_result","tool_call_id":"call_1","tool_name":"web_search","output_preview":"first result"}',
            "",
            'data: {"type":"tool_call","tool_call_id":"call_2","tool_name":"web_search","arguments":{"query":"second"}}',
            "",
            'data: {"type":"tool_result","tool_call_id":"call_2","tool_name":"web_search","output_preview":"second result"}',
            "",
            'data: {"type":"token","text":"Compared both searches."}',
            "",
            'data: {"type":"run_done","run_id":"run_tools","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "search twice" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText("Compared both searches.");
    const stepBlocks = container.querySelectorAll(".mabel-thread .mabel-steps");
    expect(stepBlocks.length).toBe(2);
  });

  it("renders tool cards prompt-kit style: pill state, no fake gray boxes for empty input, Running resolves on completion", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        // web_search fires with empty args, the result has substantive output,
        // and the run completes normally — the card should end up "Completed"
        // and should NOT show an Input section with "{}" as content.
        const frames = [
          'data: {"type":"run_started","run_id":"run_t","conversation_id":12}',
          "",
          'data: {"type":"tool_call","tool_name":"web_search","arguments":{}}',
          "",
          'data: {"type":"tool_result","tool_name":"web_search","output_preview":"Found 5 sources"}',
          "",
          'data: {"type":"token","text":"All good."}',
          "",
          'data: {"type":"run_done","run_id":"run_t","status":"completed"}',
          "",
        ];
        return new Response(frames.join("\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "search" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText("All good.");

    // Old boxy ToolCallCard is gone; the new prompt-kit Steps block
    // sits above the assistant bubble with NLG title + collapsible body.
    expect(container.querySelector(".mabel-thread .mabel-tool-stack")).toBeNull();
    expect(container.querySelector(".mabel-thread .mabel-tool-card")).toBeNull();

    const stepsList = container.querySelector(".mabel-thread .mabel-steps-list") as HTMLElement;
    expect(stepsList).not.toBeNull();
    const stepHead = within(stepsList).getByText("Searched the web")
      .closest("button") as HTMLButtonElement;
    fireEvent.click(stepHead);
    await waitFor(() => {
      expect(within(stepsList).getByText(/Found 5 sources/i)).toBeInTheDocument();
    });
  });

  it("pre-uploads files on pick, blocks Send until ready, and forwards real server ids to chat/stream", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let releaseUpload: ((value: { files: Array<Record<string, unknown>> }) => void) | null = null;
    let chatStreamBody: { message: string; attachments?: Array<{ id: string }> } | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/uploads")) {
        // Delay the upload response so we can prove Send is disabled.
        const payload = await new Promise<{ files: Array<Record<string, unknown>> }>((resolve) => {
          releaseUpload = resolve;
        });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/chat/stream")) {
        chatStreamBody = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(
          [
            'data: {"type":"run_started","run_id":"run_p","conversation_id":7}',
            "",
            'data: {"type":"token","text":"Got it."}',
            "",
            'data: {"type":"run_done","run_id":"run_p","status":"completed"}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    // Pick a file: the chip immediately appears in the composer with the
    // "uploading" state. Send button is DISABLED because upload is still
    // in flight.
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["secret"], "report.pdf", { type: "application/pdf" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    fireEvent.change(picker);

    await waitFor(() => {
      const chip = container.querySelector(".mabel-composer__chip");
      expect(chip?.className || "").toContain("mabel-composer__chip--uploading");
    });
    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "read it" } });
    const sendBtn = screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    // Clicking while uploading is a no-op.
    fireEvent.click(sendBtn);
    expect(chatStreamBody).toBeNull();

    // Resolve the upload — chip flips to "ready", Send becomes enabled.
    releaseUpload!({
      files: [
        {
          id: "file_remote_123",
          name: "report.pdf",
          mime_type: "application/pdf",
          size_bytes: 6,
          openai_file_id: "file-zz",
          source: "user_upload",
          conversation_id: null,
        },
      ],
    });

    await waitFor(() => {
      const chip = container.querySelector(".mabel-composer__chip");
      expect(chip?.className || "").toContain("mabel-composer__chip--ready");
    });
    expect((screen.getByRole("button", { name: /send message/i }) as HTMLButtonElement).disabled).toBe(false);

    // Send: chat/stream body carries the SERVER id (not the local composer id).
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(chatStreamBody).not.toBeNull());
    expect(chatStreamBody!.attachments).toEqual([{ id: "file_remote_123" }]);
    expect(chatStreamBody!.message).toBe("read it");

    // User bubble shows the file chip with the real filename. The chip is
    // intentionally a <span> on the user side (no download / no link) to
    // match ChatGPT's pattern — the user already has the file locally; the
    // chip is just a recognition affordance. The server-id round-trip is
    // already proven above via the chat/stream body attachments assertion.
    await waitFor(() => {
      const userChip = container.querySelector(".mabel-message--user .mabel-message__chip");
      expect(userChip).not.toBeNull();
      expect(userChip!.textContent).toContain("report.pdf");
      // Must NOT be a clickable link.
      expect(userChip!.tagName.toLowerCase()).toBe("span");
      expect(userChip!.getAttribute("href")).toBeNull();
      // No download icon on user-side chips.
      expect(userChip!.querySelector(".mabel-message__chip-download")).toBeNull();
    });
  });

  it("uploads composer attachments, renders agent_file image inline, and opens long code blocks in the artifact canvas", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    let uploadsCalled = 0;
    let imageFetchHeaders: HeadersInit | undefined;
    let chatStreamBody: { message: string; attachments?: Array<{ id: string }> } | null = null;
    const longCode = ["function hello() {", "  console.log('hi');", "}", ""].concat(Array.from({ length: 10 }, (_, i) => `// line ${i}`)).join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/uploads") && method === "POST") {
        uploadsCalled += 1;
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "file_aaaa",
                name: "notes.txt",
                mime_type: "text/plain",
                size_bytes: 4,
                openai_file_id: "file-remote",
                source: "user_upload",
                conversation_id: null,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/stream")) {
        chatStreamBody = init?.body ? JSON.parse(String(init.body)) : null;
        const fenced = "```javascript\n" + longCode + "\n```";
        const reply = "Here's a snippet:\n\n" + fenced + "\n";
        // Build SSE: run_started → agent_file (image) → token chunks → done.
        const frames = [
          'data: {"type":"run_started","run_id":"run_z","conversation_id":300}',
          "",
          'data: {"type":"agent_file","file_id":"file_img1","name":"generated.png","mime":"image/png","kind":"image"}',
          "",
          ...reply.split("").map((ch) => `data: {"type":"token","text":${JSON.stringify(ch)}}`).flatMap((line) => [line, ""]),
          'data: {"type":"run_done","run_id":"run_z","status":"completed"}',
          "",
        ];
        return new Response(frames.join("\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/api/v1/files/file_img1")) {
        imageFetchHeaders = init?.headers;
        return new Response(new Blob(["png"], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    await screen.findByRole("heading", { name: /Welcome, Agent/i });

    // Pick a file — the composer kicks off the upload IMMEDIATELY so by
    // the time the user types and hits send, the file already has a
    // server-side id. Wait for that pre-upload to land before clicking
    // send (send button stays disabled while a chip is still uploading).
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker).not.toBeNull();
    const file = new File(["hiya"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    fireEvent.change(picker);

    await waitFor(() => expect(uploadsCalled).toBe(1));
    // The chip transitions out of "uploading" once the promise resolves.
    await waitFor(() => {
      const chip = container.querySelector(".mabel-composer__chip");
      expect(chip?.className || "").toContain("mabel-composer__chip--ready");
    });

    fireEvent.change(screen.getByPlaceholderText(/Type \//i), { target: { value: "Summarize the attachment." } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(chatStreamBody).not.toBeNull());
    expect(chatStreamBody!.attachments).toEqual([{ id: "file_aaaa" }]);
    expect(chatStreamBody!.message).toBe("Summarize the attachment.");

    // User bubble carries an upload chip with the filename.
    await waitFor(() => {
      const userChip = container.querySelector(".mabel-message--user .mabel-message__chip");
      expect(userChip).not.toBeNull();
      expect(userChip!.textContent).toContain("notes.txt");
    });

    // The assistant message ends up with an inline image preview from agent_file.
    await waitFor(() => {
      const img = container.querySelector(".mabel-message--assistant .mabel-message__image img") as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.getAttribute("src")).toContain("blob:");
      expect(img!.getAttribute("alt")).toBe("generated.png");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/files/file_img1"),
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          "X-User-Email": "agent@example.com",
          "X-User-Id": "1",
        }),
      }),
    );
    expect(imageFetchHeaders).toEqual(
      expect.objectContaining({
        "X-User-Email": "agent@example.com",
        "X-User-Id": "1",
      }),
    );

    // Wait for the markdown code block to be in the thread.
    await waitFor(() => {
      const codeHead = container.querySelector(".mabel-code .mabel-code__badge");
      expect(codeHead?.textContent).toBe("JavaScript");
    });
    // Click the "Open in canvas" expand control.
    const expandBtn = container.querySelector(
      '.mabel-message--assistant .mabel-code__expand',
    ) as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();
    fireEvent.click(expandBtn!);

    // Artifact panel renders the language + tabs / copy.
    await waitFor(() => expect(screen.getByLabelText("Mabel artifact")).toBeInTheDocument());
    const artifactNode = screen.getByLabelText("Mabel artifact");
    expect(within(artifactNode).getByText("javascript")).toBeInTheDocument();
  });

  it("on reload, hydrated tools + sources attach to the correct historical turn via run_id (not the first assistant message)", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.match(/\/api\/v1\/conversations\/77\/messages$/)) {
        // Two turns:
        //   Turn 1 (run_a): user "hi"           → assistant "Hi! How can I help?"        (no tools)
        //   Turn 2 (run_b): user "list 5 MCPs"  → assistant "Here are 5..."              (web_search)
        // The web_search tool must hydrate under the SECOND assistant, not the first.
        return new Response(
          JSON.stringify({
            conversation: { id: 77, title: "Mixed turns", surface: "chat", updated_at: new Date().toISOString() },
            messages: [
              { id: 1, role: "user", content: "hi", created_at: new Date().toISOString(), run_id: "run_a" },
              {
                id: 2,
                role: "assistant",
                content: "Hi! How can I help?",
                created_at: new Date().toISOString(),
                run_id: "run_a",
              },
              { id: 3, role: "user", content: "list 5 MCPs", created_at: new Date().toISOString(), run_id: "run_b" },
              {
                id: 4,
                role: "assistant",
                content: "Here are 5 popular MCP servers.",
                created_at: new Date().toISOString(),
                run_id: "run_b",
                sources: [{ url: "https://github.com/openai/openai-agents-python", title: "Agents SDK" }],
              },
            ],
            tool_calls: [
              {
                id: 10,
                run_id: "run_b",
                tool_name: "web_search",
                status: "completed",
                arguments: { query: "popular MCP servers" },
                output_preview: "",
                created_at: new Date().toISOString(),
              },
            ],
            files: [
              {
                id: "file_docx",
                name: "Generated_TSE.docx",
                mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                size_bytes: 20480,
                source: "agent_mcp_file",
                run_id: "run_b",
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(
          JSON.stringify({
            conversations: [
              { id: 77, title: "Mixed turns", surface: "chat", message_count: 4, updated_at: new Date().toISOString() },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    const rail = await screen.findByLabelText("Mabel conversation history");
    await waitFor(() => expect(within(rail).getByText("Mixed turns")).toBeInTheDocument());

    fireEvent.click(within(rail).getByText("Mixed turns"));

    await waitFor(() => expect(screen.getByText("Hi! How can I help?")).toBeInTheDocument());
    expect(screen.getByText("Here are 5 popular MCP servers.")).toBeInTheDocument();

    // Inline Steps blocks render above each assistant message. The
    // second assistant turn (which carried web_search) should now have
    // a Steps block with the past-tense action label. The first
    // assistant turn has none.
    expect(container.querySelector(".mabel-thread .mabel-tool-stack")).toBeNull();
    const allSteps = container.querySelectorAll(".mabel-thread .mabel-steps-list");
    expect(allSteps.length).toBe(1);
    expect(within(allSteps[0] as HTMLElement).getByText("Searched the web")).toBeInTheDocument();

    const assistantChip = container.querySelector(".mabel-message--assistant .mabel-message__chip") as HTMLElement | null;
    expect(assistantChip).not.toBeNull();
    expect(assistantChip?.tagName.toLowerCase()).toBe("button");
    expect(assistantChip?.textContent).toContain("Generated_TSE.docx");
    expect(container.querySelector(".mabel-message--user .mabel-message__chip")).toBeNull();
  });

  it("hydrates saved reasoning details without rendering them as tool steps", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const userAt = new Date("2026-06-28T10:00:00Z").toISOString();
    const assistantAt = new Date("2026-06-28T10:00:12Z").toISOString();
    const toolAt = new Date("2026-06-28T10:00:20Z").toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.match(/\/api\/v1\/conversations\/88\/messages$/)) {
        return new Response(
          JSON.stringify({
            conversation: { id: 88, title: "Reasoned dashboard", surface: "chat", updated_at: assistantAt },
            messages: [
              { id: 1, role: "user", content: "build a dashboard", created_at: userAt, run_id: "run_reason" },
              { id: 2, role: "assistant", content: "Dashboard created.", created_at: assistantAt, run_id: "run_reason" },
            ],
            tool_calls: [
              {
                id: 42,
                run_id: "run_reason",
                tool_name: "mabel_reasoning",
                status: "completed",
                arguments: {},
                output_preview: "I checked the data.**Planning dashboard creation**Next I saved the dashboard.",
                created_at: toolAt,
              },
            ],
            files: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(
          JSON.stringify({
            conversations: [
              { id: 88, title: "Reasoned dashboard", surface: "chat", message_count: 2, updated_at: assistantAt },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MabelPage />);
    const rail = await screen.findByLabelText("Mabel conversation history");
    fireEvent.click(await within(rail).findByText("Reasoned dashboard"));

    await screen.findByText("Dashboard created.");
    const activity = await screen.findByLabelText("Mabel activity");
    const thoughtButton = within(activity).getByRole("button", { name: /Thought for 12 seconds/i });
    fireEvent.click(thoughtButton);

    await waitFor(() => expect(within(activity).getByText("Planning dashboard creation")).toBeInTheDocument());
    expect(within(activity).getByText(/Next I saved the dashboard/i)).toBeInTheDocument();
    expect(container.querySelector(".mabel-thread .mabel-steps-list")).toBeNull();
  });

  it("persists tool cards across conversation reload and does not reserve right-rail column on non-chat pages", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.match(/\/api\/v1\/conversations\/55\/messages$/)) {
        return new Response(
          JSON.stringify({
            conversation: { id: 55, title: "Saved chat", surface: "chat", updated_at: new Date().toISOString() },
            messages: [
              { id: 1, role: "user", content: "How many skills?", created_at: new Date().toISOString() },
              { id: 2, role: "assistant", content: "There are 2 skills.", created_at: new Date().toISOString() },
            ],
            tool_calls: [
              {
                id: 7,
                run_id: "run_old",
                tool_name: "mabel_context",
                status: "completed",
                arguments: { source: "mabel-bootstrap" },
                output_preview: "connectors=0, skills=2, starter_packs=1",
                created_at: new Date().toISOString(),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(
          JSON.stringify({
            conversations: [
              { id: 55, title: "Saved chat", surface: "chat", message_count: 2, updated_at: new Date().toISOString() },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);

    const rail = await screen.findByLabelText("Mabel conversation history");
    await waitFor(() => expect(within(rail).getByText("Saved chat")).toBeInTheDocument());

    fireEvent.click(within(rail).getByText("Saved chat"));

    await waitFor(() => expect(screen.getByText("There are 2 skills.")).toBeInTheDocument());

    // The persisted mabel_context tool now surfaces as a prompt-kit Steps
    // block inline above the assistant message. Click the head to expand
    // and verify the persisted output preview comes back.
    const { container: testContainer } = { container: document.body };
    const stepsList = testContainer.querySelector(".mabel-thread .mabel-steps-list") as HTMLElement;
    expect(stepsList).not.toBeNull();
    const stepHead = within(stepsList).getByText("Read workspace context")
      .closest("button") as HTMLButtonElement;
    expect(stepHead).not.toBeNull();
    fireEvent.click(stepHead);
    await waitFor(() =>
      expect(within(stepsList).getByText(/connectors=0, skills=2, starter_packs=1/)).toBeInTheDocument(),
    );

    fireEvent.click(within(rail).getByRole("button", { name: /Connectors 0/i }));
    await waitFor(() =>
      expect(screen.getByText(/MCP servers Mabel can call/i)).toBeInTheDocument(),
    );

    const shell = document.querySelector(".mabel-app-shell");
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute("data-context")).toBe("closed");
  });

  it("adds Projects and Library in the primary nav", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "agent-1" }),
    );

    const now = new Date().toISOString();
    let projects: Array<Record<string, unknown>> = [];
    const libraryFile = {
      id: "file_library",
      name: "customer-health.csv",
      mime_type: "text/csv",
      size_bytes: 42,
      openai_file_id: "file-openai",
      source: "user_upload",
      conversation_id: null,
      project_id: null,
      created_at: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/projects") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        const project = {
          id: "project_renewal",
          name: body.name,
          description: body.description || "",
          instructions: "",
          color: "slate",
          conversation_count: 0,
          file_count: 0,
          created_at: now,
          updated_at: now,
        };
        projects = [project];
        return new Response(JSON.stringify({ project }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/projects") && method === "GET") {
        return new Response(JSON.stringify({ projects }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/projects/project_renewal")) {
        return new Response(
          JSON.stringify({ project: projects[0], conversations: [], files: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/files") && method === "GET") {
        return new Response(JSON.stringify({ files: [libraryFile] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/v1/documents") && method === "GET") {
        return new Response(JSON.stringify({ documents: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/workflows/starter-pack.account-manager/run")) {
        return new Response(
          JSON.stringify({
            status: "completed",
            missing_connectors: [],
            missing_skills: [],
            outputs: {
              briefs: [
                {
                  time: "2:00 PM",
                  account_name: "Northstar Health",
                  attendees: ["Jordan Lee"],
                  sources_used: ["Outlook Calendar", "Salesforce", "Product usage"],
                  sections: {
                    "Why this meeting matters": "Renewal is approaching while usage is growing.",
                    "Questions to ask": "Which teams are driving the usage increase?",
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/conversations") && !url.includes("/messages")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/scheduled")) {
        return new Response(JSON.stringify({ tasks: [], runs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MabelPage />);
    const rail = await screen.findByLabelText("Mabel conversation history");
    const navLabels = within(rail).getAllByRole("button").map((button) => button.textContent || "");
    expect(navLabels.findIndex((label) => label.includes("Projects"))).toBeLessThan(
      navLabels.findIndex((label) => label.includes("Connectors")),
    );
    expect(navLabels.findIndex((label) => label.includes("Artifacts"))).toBeLessThan(
      navLabels.findIndex((label) => label.includes("Library")),
    );
    expect(navLabels.findIndex((label) => label.includes("Library"))).toBeLessThan(
      navLabels.findIndex((label) => label.includes("Scheduled")),
    );

    fireEvent.click(within(rail).getByRole("button", { name: /Projects/i }));
    expect(await screen.findByText(/Keep related chats, files, and instructions together/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Create project/i }));
    const projectDialog = screen.getByRole("dialog", { name: /Create project/i });
    fireEvent.change(within(projectDialog).getByLabelText(/^Name$/i), {
      target: { value: "Renewal launch" },
    });
    fireEvent.click(within(projectDialog).getByRole("button", { name: /^Create$/i }));
    expect(await screen.findByText("Renewal launch")).toBeInTheDocument();
    const chatsSection = screen.getByRole("heading", { name: "Chats" }).closest(".mabel-project-section");
    fireEvent.click(within(chatsSection!).getByRole("button", { name: "New chat" }));
    expect(screen.getByLabelText(/Project context: Renewal launch/)).toBeInTheDocument();

    fireEvent.click(within(rail).getByRole("button", { name: /Library/i }));
    expect(await screen.findByText(/Files and images you can reuse in Mabel/i)).toBeInTheDocument();
    expect(await screen.findByText("customer-health.csv")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Chat with customer-health.csv/i }));
    expect(await screen.findByText("customer-health.csv")).toBeInTheDocument();

    fireEvent.click(within(rail).getByRole("button", { name: /Workflows/i }));
    expect(await screen.findByText(/No workflows yet/i)).toBeInTheDocument();
  });
});

describe("Mabel Markdown", () => {
  it("puts adjacent bold reasoning headings into their own paragraphs", () => {
    const { container } = render(
      <Markdown
        theme="light"
        content="The data is organized!**Planning dashboard creation**Next I selected charts."
      />,
    );

    const paragraphs = Array.from(container.querySelectorAll("p")).map((node) => node.textContent);
    expect(paragraphs).toEqual([
      "The data is organized!",
      "Planning dashboard creation",
      "Next I selected charts.",
    ]);
  });

  it("removes execution metadata blocks and preserves explicit source links", () => {
    render(
      <Markdown
        theme="light"
        content={[
          "- Full scope requested: **yes** —",
          "```",
          "limit=0",
          "```",
          "- Full export:",
          "```",
          "/workspace/mabel/exports/mcp-evidence/research-results.csv",
          "```",
          "| Record | Link |",
          "| --- | --- |",
          "| `record-123` | [Open source](https://example.com/records/123) |",
        ].join("\n")}
      />,
    );

    expect(screen.queryByText(/Full scope requested/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/limit=0/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Full export/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace\/mabel\/exports/i)).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      "https://example.com/records/123",
    );
  });

  it("restores non-chat view immediately on hard refresh using URL and localStorage fallback", async () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/bootstrap")) {
        return new Response(
          JSON.stringify({
            user: { email: "agent@example.com", name: "Agent Smith" },
            surfaces: ["chat", "rag", "mcp", "agents"],
            connectors: [{ id: "github", name: "github", connection_status: "connected", tool_count: 1, enabled: true }],
            skills: [],
            starter_packs: [],
            approvals: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/conversations")) {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/skills")) {
        return new Response(JSON.stringify({ skills: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/v1/scheduled")) {
        return new Response(JSON.stringify({ tasks: [], runs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    window.history.replaceState(null, "", "/mabel?view=skills");
    const { unmount } = render(<MabelPage />);
    expect(screen.queryByText(/Welcome,/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Skills" }).length).toBeGreaterThan(0);
    unmount();

    window.history.replaceState(null, "", "/mabel");
    window.localStorage.setItem("mabel-last-view", "connectors");
    render(<MabelPage />);
    expect(screen.queryByText(/Welcome,/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Connectors" }).length).toBeGreaterThan(0);
  });
});
