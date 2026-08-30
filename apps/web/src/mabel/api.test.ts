import { describe, expect, it, vi } from "vitest";

import { getAuthHeaders } from "@/lib/auth";
import {
  getMabelAdminAccess,
  getMabelAdminLogs,
  getMabelNormalizationHealth,
  getMabelScheduled,
  getMabelSkills,
  parseMabelSseFrames,
  mabelApiUrl,
  resumeMabelWorkflowRun,
  runMabelScheduledTask,
  runMabelWorkflow,
  updateMabelScheduledTask,
  uploadMabelFiles,
} from "./api";

describe("Mabel API helpers", () => {
  it("builds same-origin mabel URLs", () => {
    expect(mabelApiUrl("/api/v1/bootstrap")).toBe("/mabel-api/api/v1/bootstrap");
    expect(mabelApiUrl("api/v1/bootstrap", "/custom")).toBe("/custom/api/v1/bootstrap");
  });

  it("parses data-only SSE frames", () => {
    const events = parseMabelSseFrames(
      [
        'data: {"type":"run_started","run_id":"run_1"}',
        "",
        'data: {"type":"token","text":"hello"}',
        "",
        'data: {"type":"run_done","status":"completed"}',
        "",
      ].join("\n"),
    );

    expect(events).toEqual([
      { type: "run_started", run_id: "run_1" },
      { type: "token", text: "hello" },
      { type: "run_done", status: "completed" },
    ]);
  });

  it("parses CRLF SSE frames", () => {
    const events = parseMabelSseFrames(
      'data: {"type":"token","text":"hello"}\r\n\r\ndata: {"type":"run_done","status":"completed"}\r\n\r\n',
    );

    expect(events).toEqual([
      { type: "token", text: "hello" },
      { type: "run_done", status: "completed" },
    ]);
  });

  it("sends a stable user id header for Mabel history ownership", () => {
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith" }),
    );

    expect(getAuthHeaders()).toMatchObject({
      "X-User-Email": "agent@example.com",
      "X-User-Name": "Agent Smith",
      "X-User-Id": "agent@example.com",
    });

    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "agent-1" }),
    );

    expect(getAuthHeaders()["X-User-Id"]).toBe("agent-1");
    window.localStorage.clear();
  });

  it("uploadMabelFiles does NOT send Content-Type application/json (FastAPI needs the browser-set multipart boundary)", async () => {
    // The shared getAuthHeaders() helper defaults to {"Content-Type":
    // "application/json"} for every Mabel API call. For multipart uploads
    // that header poisons the request — FastAPI's UploadFile parser fails
    // and returns 422 before any byte is read. uploadMabelFiles must
    // strip that header so the browser auto-sets the multipart boundary.
    window.localStorage.setItem(
      "mabel-current-user",
      JSON.stringify({ email: "agent@example.com", name: "Agent Smith", sub: "1" }),
    );
    let captured: { headers?: Record<string, string>; body?: unknown } = {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = { headers: init?.headers as Record<string, string>, body: init?.body };
      return new Response(
        JSON.stringify({ files: [{ id: "file_test", name: "x.txt", mime_type: "text/plain", size_bytes: 1, openai_file_id: null, source: "user_upload", conversation_id: null }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["hello"], "x.txt", { type: "text/plain" });
    await uploadMabelFiles([file]);

    // The custom Content-Type MUST NOT be present — the browser sets the
    // boundary-aware multipart Content-Type itself.
    const headers = captured.headers || {};
    const ctKey = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
    expect(ctKey).toBeUndefined();
    // Auth headers (used by the backend resolve_mabel_user middleware) still
    // need to flow through.
    expect(headers["X-User-Email"]).toBe("agent@example.com");
    // And the body is a FormData instance — proves we sent multipart.
    expect(captured.body).toBeInstanceOf(FormData);
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("getMabelSkills forwards encoded query and returns ranked rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/v1/skills?query=account%20prep");
      return new Response(
        JSON.stringify({
          query: "account prep",
          skills: [
            {
              id: "skill.account-context",
              name: "Account Context",
              status: "published",
              score: 8.2,
              matched_fields: ["name", "description"],
              snippet: "Build account prep notes...",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await getMabelSkills("account prep");
    expect(rows[0].id).toBe("skill.account-context");
    expect(rows[0].score).toBe(8.2);
    expect(rows[0].matched_fields).toEqual(["name", "description"]);
    vi.unstubAllGlobals();
  });

  it("getMabelNormalizationHealth loads rollout status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/v1/health/normalization");
      return new Response(
        JSON.stringify({
          store: "postgres",
          strict_reads: true,
          ready_for_strict_reads: true,
          backfill_gap: { conversations: 0, messages: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const payload = await getMabelNormalizationHealth();
    expect(payload.store).toBe("postgres");
    expect(payload.strict_reads).toBe(true);
    expect(payload.ready_for_strict_reads).toBe(true);
    vi.unstubAllGlobals();
  });

  it("loads Mabel admin access and Logs with query parameters", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/admin/check-access")) {
        return new Response(JSON.stringify({ is_admin: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(url).toContain("/api/v1/admin/logs?days=7&limit=5");
      return new Response(
        JSON.stringify({
          totals: { requests: 2, total_tokens: 40, tool_calls: 3 },
          recent: { usage: [] },
          counts: { usage_events: 2, tool_calls: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMabelAdminAccess()).resolves.toEqual({ is_admin: true });
    const logs = await getMabelAdminLogs({ days: 7, limit: 5 });
    expect(logs.totals?.requests).toBe(2);
    expect(logs.counts?.tool_calls).toBe(3);
    vi.unstubAllGlobals();
  });

  it("runMabelWorkflow returns the agent-loop execution plan contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/v1/workflows/workflow-pack.test/run");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ objective: "Start my day", dry_run: false });
      return new Response(
        JSON.stringify({
          run_id: "workflow_123",
          status: "completed",
          objective: "Start my day",
          checkpoints: [],
          outputs: {
            execution_plan: {
              mode: "agent_loop",
              objective: "Start my day",
              schedule: { cadence: "daily" },
              steps: [
                {
                  id: "step-1",
                  title: "Start My Day",
                  command: "/start-my-day",
                  objective: "Prepare brief",
                  status: "completed",
                  skill_ids: ["skill.tse-master"],
                  connector_slugs: ["github"],
                  uses_chat_runtime: true,
                  result: { status: "completed", summary: "Generated 1 draft brief." },
                },
              ],
            },
            step_results: [{ step_id: "step-1", status: "completed" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await runMabelWorkflow("workflow-pack.test", { objective: "Start my day", dry_run: false });

    expect(payload.outputs?.execution_plan?.mode).toBe("agent_loop");
    expect(payload.outputs?.execution_plan?.steps[0].uses_chat_runtime).toBe(true);
    expect(payload.outputs?.execution_plan?.steps[0].status).toBe("completed");
    expect(payload.outputs?.step_results?.[0].status).toBe("completed");
    vi.unstubAllGlobals();
  });

  it("loads, updates, and runs scheduled tasks", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            tasks: [{ id: "sched_1", name: "Daily ops", prompt: "Check ops", schedule_kind: "morning", cron: "0 9 * * *", timezone: "UTC", status: "active", mode: "standalone", notification_mode: "notify_on_change" }],
            runs: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "PATCH") {
        return new Response(
          JSON.stringify({ task: { id: "sched_1", name: "Daily ops", prompt: "Check ops", schedule_kind: "morning", cron: "0 9 * * *", timezone: "UTC", status: "paused", mode: "standalone", notification_mode: "notify_on_change" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          task: { id: "sched_1", name: "Daily ops", prompt: "Check ops", schedule_kind: "morning", cron: "0 9 * * *", timezone: "UTC", status: "active", mode: "standalone", notification_mode: "notify_on_change" },
          run: { id: "scheduled_1", task_id: "sched_1", status: "completed", summary: "Queued." },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const listed = await getMabelScheduled();
    expect(listed.tasks[0].id).toBe("sched_1");
    const updated = await updateMabelScheduledTask("sched_1", { status: "paused" });
    expect(updated.status).toBe("paused");
    const run = await runMabelScheduledTask("sched_1");
    expect(run.run.id).toBe("scheduled_1");
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH", "POST"]);
    expect(calls[1].url).toContain("/api/v1/scheduled/sched_1");
    expect(calls[2].url).toContain("/api/v1/scheduled/sched_1/run");
    vi.unstubAllGlobals();
  });

  it("resumeMabelWorkflowRun calls the workflow resume endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/v1/workflows/runs/workflow_123/resume");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ status: "running", run_id: "workflow_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await resumeMabelWorkflowRun("workflow_123");

    expect(payload.status).toBe("running");
    vi.unstubAllGlobals();
  });
});
