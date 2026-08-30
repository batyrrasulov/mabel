import { useMemo, useState } from "react";

import { callMcpTool, listMcpTools, setConnectorEnabled, syncMcpConnectors } from "../api";
import { mabelUiConnectorDisplayName, mabelUiConnectorIsAvailable, mabelUiConnectorToggleAllowed, mabelUiVisibleConnectors } from "../connectorUi";
import { mabelMcpToolDescription } from "../mcpToolDescription";
import type { UsageMap } from "../hooks/useUsageTracker";
import { RecentSessions } from "./RecentSessions";
import type { MabelBootstrap, MabelConversationSummary } from "../types";

type ConnectorsPageProps = {
  bootstrap: MabelBootstrap;
  onRefresh: () => Promise<void> | void;
  onRefreshBootstrap?: () => Promise<void> | void;
  onUseInChat: (prompt: string, intent?: { kind: "connector"; id: string }) => void;
  usage: UsageMap;
  conversations: MabelConversationSummary[];
  onOpenConversation: (conversationId: number) => void;
};

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

type ToolInfo = {
  name?: string;
  description?: string;
  inputSchema?: JsonSchema;
};

type ToolCallFeedback = {
  kind: "success" | "approval" | "error";
  label: "Success" | "Approval" | "Failed";
  detail: string;
  output?: string;
};

function formatToolDescription(tool: ToolInfo, connectorId: string): string {
  return mabelMcpToolDescription(tool.name || "", connectorId, tool.description);
}

function formatOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickSchemaType(schema?: JsonSchema): string | undefined {
  const type = schema?.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    return type.find((entry) => entry !== "null");
  }
  return undefined;
}

function schemaBranch(schema?: JsonSchema): JsonSchema | undefined {
  if (!schema) return undefined;
  return schema.oneOf?.[0] || schema.anyOf?.[0] || schema.allOf?.[0];
}

function buildSchemaValue(schema?: JsonSchema): unknown {
  if (!schema) return "";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const branch = schemaBranch(schema);
  if (branch) return buildSchemaValue(branch);

  const type = pickSchemaType(schema);
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  if (type === "array") return [];
  if (type === "object" || schema.properties) {
    const output: Record<string, unknown> = {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = schema.properties || {};
    for (const key of required) {
      output[key] = buildSchemaValue(properties[key]);
    }
    return output;
  }
  return "";
}

function buildTestArgs(tool: ToolInfo): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema) return {};
  const type = pickSchemaType(schema);
  if (type === "object" || schema.properties || (Array.isArray(schema.required) && schema.required.length > 0)) {
    const value = buildSchemaValue(schema);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }
  return {};
}

function summarizeToolCallResponse(response: unknown): ToolCallFeedback {
  if (!response || typeof response !== "object") {
    return { kind: "success", label: "Success", detail: "Tool call succeeded.", output: formatOutput(response) };
  }

  const payload = response as {
    status?: string;
    approval?: { id?: string; title?: string };
    response?: {
      result?: {
        content?: Array<{ type?: string; text?: string }>;
      };
    };
  };

  if (payload.status === "approval_required") {
    const approvalId = payload.approval?.id ? ` (${payload.approval.id})` : "";
    return {
      kind: "approval",
      label: "Approval",
      detail: `${payload.approval?.title || "Approval requested"}${approvalId}`,
      output: formatOutput(payload),
    };
  }

  const parts = (payload.response?.result?.content || [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => (item.text || "").trim())
    .filter(Boolean);
  if (parts.length > 0) {
    const preview = parts.join(" ").replace(/\s+/g, " ").slice(0, 220);
    return {
      kind: "success",
      label: "Success",
      detail: preview,
      output: formatOutput(payload.response?.result ?? payload),
    };
  }

  return {
    kind: "success",
    label: "Success",
    detail: "Tool call succeeded.",
    output: formatOutput(payload.response?.result ?? payload),
  };
}

function canInspectTools(connector: MabelBootstrap["connectors"][number]): boolean {
  return (
    connector.enabled !== false &&
    ["connected", "remote_gateway_available", "local_package_available"].includes(connector.connection_status)
  );
}

function connectorDescription(connector: MabelBootstrap["connectors"][number]): string {
  const descriptions: Record<string, string> = {
    asana: "Official connector to access Asana projects, tasks, and workflows via AI tools.",
    atlassian: "Access Jira issues, Confluence pages, and other Atlassian products via AI tools.",
    datadog: "Monitor infrastructure, logs, metrics, APM traces, and manage alerts with Datadog observability platform.",
    figma: "Official connector to access Figma designs, extract design context, variables, and generate code from design files via AI tools.",
    github: "Official connector to manage repositories, issues, pull requests, and code on GitHub via AI tools.",
    "google-docs": "Custom built connector to create, read, and edit Google Docs documents via AI tools.",
    "google-sheets": "Custom built connector to read, write, and analyze spreadsheet data via AI tools.",
    "google-slides": "Custom built connector to create, read, and edit Google Slides presentations via AI tools.",
    "microsoft-teams": "Access Microsoft Teams chats, channels, and membership data through Microsoft Graph-powered MCP tools.",
    "outlook-calendar": "Read and manage Outlook Calendar events through Microsoft Graph Calendar APIs.",
    "outlook-email": "Read and send Outlook email through Microsoft Graph Mail APIs.",
    salesforce: "Manage sales and revenue data in Salesforce accounts, contacts, leads, opportunities, quotes, orders, contracts, and products.",
    sharepoint: "Access and manage documents and sites in SharePoint via AI tools.",
    slack: "Slack integration that acts as you, with full access to your slack workspace, including your public and private channels, file uploads, channel management and will post messages with your user name. Recommended for most users.",
  };
  const fallback = (connector.description || "").trim();
  return descriptions[connector.id] || fallback;
}

export function ConnectorsPage({ bootstrap, onRefresh, onRefreshBootstrap, onUseInChat, usage, conversations, onOpenConversation }: ConnectorsPageProps) {
  const [search, setSearch] = useState("");
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [tools, setTools] = useState<Record<string, ToolInfo[]>>({});
  const [toolSourceBySlug, setToolSourceBySlug] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toolCallBusy, setToolCallBusy] = useState<Record<string, boolean>>({});
  const [toolCallFeedback, setToolCallFeedback] = useState<Record<string, ToolCallFeedback>>({});
  const [toolOutputOpen, setToolOutputOpen] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await syncMcpConnectors();
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const filtered = useMemo(() => {
    const visible = mabelUiVisibleConnectors(bootstrap.connectors);
    const q = search.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter((c) => {
      const label = mabelUiConnectorDisplayName(c.id, c.name).toLowerCase();
      return label.includes(q) || c.id.toLowerCase().includes(q);
    });
  }, [bootstrap.connectors, search]);

  const loadTools = async (slug: string) => {
    if (openSlug === slug) {
      setOpenSlug(null);
      return;
    }

    // Re-open instantly when we already have a cached tools payload for this connector.
    if (Object.prototype.hasOwnProperty.call(tools, slug)) {
      setErrors((prev) => ({ ...prev, [slug]: "" }));
      setOpenSlug(slug);
      return;
    }

    setBusy(slug);
    setErrors((prev) => ({ ...prev, [slug]: "" }));
    try {
      const response = await listMcpTools(slug);
      setTools((prev) => ({ ...prev, [slug]: (response.tools as ToolInfo[]) || [] }));
      setToolSourceBySlug((prev) => ({ ...prev, [slug]: response.source || "live" }));
      setOpenSlug(slug);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [slug]: err instanceof Error ? err.message : "failed" }));
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (slug: string, enabled: boolean) => {
    try {
      await setConnectorEnabled(slug, enabled);
      if (!enabled) {
        if (openSlug === slug) setOpenSlug(null);
        setTools((prev) => {
          const next = { ...prev };
          delete next[slug];
          return next;
        });
        setToolSourceBySlug((prev) => {
          const next = { ...prev };
          delete next[slug];
          return next;
        });
      }
      await (onRefreshBootstrap ?? onRefresh)();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [slug]: err instanceof Error ? err.message : "failed" }));
    }
  };

  return (
    <div className="mabel-page mabel-connectors-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Connectors</h1>
          <p>MCP servers Mabel can call. Toggle availability, inspect tools, and test calls.</p>
        </div>
        <div className="mabel-page__actions">
          <input
            className="mabel-page__search"
            placeholder="Search connectors"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="mabel-button mabel-button--ghost"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="mabel-page__body">
        <section className="mabel-card">
          {filtered.length === 0 ? (
            <p className="mabel-muted">
              {mabelUiVisibleConnectors(bootstrap.connectors).length === 0
                ? "No connectors registered yet. Refresh the page after the Mabel catalog seed runs, or check bootstrap/API health."
                : "No connectors match this search."}
            </p>
          ) : (
            <ul className="mabel-page__list">
              {filtered.map((connector) => {
                const inspectable = canInspectTools(connector);
                const statusOk = mabelUiConnectorIsAvailable(connector);
                const statusLabel = statusOk ? "Available" : "Not Available";
                const toggleAllowed = mabelUiConnectorToggleAllowed(connector.id);
                const rowClassName = `mabel-page__row mabel-page__row--column${connector.enabled === false ? " mabel-page__row--disabled" : ""}`;
                const description = connectorDescription(connector);
                return (
                <li key={connector.id} className={rowClassName}>
                  <div className="mabel-page__row-top">
                    <div className="mabel-page__row-main">
                      <div className="mabel-page__row-title-line">
                        <strong>{mabelUiConnectorDisplayName(connector.id, connector.name)}</strong>
                      </div>
                      <span className="mabel-page__row-id">{connector.id}</span>
                    </div>
                    <span className="mabel-page__row-description mabel-page__connector-description" title={description}>
                      {description}
                    </span>
                    <div className="mabel-page__row-side">
                      <span
                        className={`mabel-status-dot mabel-status-dot--${
                          statusOk ? "ok" : "warn"
                        }`}
                      />
                      <span className="mabel-page__row-meta">{statusLabel}</span>
                      <span className="mabel-page__row-meta">
                        {(connector.tool_count ?? 0)} tools
                      </span>
                    </div>
                    <div className="mabel-page__row-actions">
                      <label className="mabel-toggle">
                        <input
                          type="checkbox"
                          checked={connector.enabled !== false}
                          disabled={!toggleAllowed}
                          title={toggleAllowed ? undefined : "This connector is managed outside Mabel for now"}
                          onChange={(event) => toggleEnabled(connector.id, event.target.checked)}
                        />
                        <span>{connector.enabled === false ? "Disabled" : "Enabled"}</span>
                      </label>
                      <button
                        type="button"
                        className="mabel-button mabel-button--ghost"
                        onClick={() => loadTools(connector.id)}
                        disabled={busy === connector.id || !inspectable}
                        title={inspectable ? "Fetch MCP tools" : "Configure a Remote Gateway or local MCP endpoint before inspecting tools"}
                      >
                        {busy === connector.id ? "Loading…" : openSlug === connector.id ? "Hide tools" : "View tools"}
                      </button>
                      <button
                        type="button"
                        className="mabel-button"
                        onClick={() =>
                          onUseInChat(
                            `Use the ${mabelUiConnectorDisplayName(connector.id, connector.name)} MCP connector. List or describe my approved tools first.`,
                            { kind: "connector", id: connector.id },
                          )
                        }
                      >
                        Use in chat
                      </button>
                    </div>
                  </div>
                  <RecentSessions
                    label="Recent sessions"
                    conversationIds={usage[connector.id] || []}
                    conversations={conversations}
                    onOpen={onOpenConversation}
                  />
                  {openSlug === connector.id ? (
                    <div className="mabel-page__sub">
                      {errors[connector.id] ? <div className="mabel-form__error">{errors[connector.id]}</div> : null}
                      {(tools[connector.id] || []).length === 0 ? (
                        <p className="mabel-muted">No tools returned.</p>
                      ) : (
                        <ul className="mabel-page__tools">
                          {(tools[connector.id] || []).map((tool, index) => {
                            const description = formatToolDescription(tool, connector.id);
                            const toolName = tool.name || "tool";
                            const callKey = `${connector.id}::${toolName}`;
                            return (
                            <li key={index} className="mabel-page__tool">
                              <div className="mabel-page__tool-main">
                                <strong>{toolName}</strong>
                                {description ? <span>{description}</span> : null}
                              </div>
                              <div className="mabel-page__tool-actions">
                                {toolCallFeedback[callKey] ? (
                                  <span className={`mabel-page__tool-result mabel-page__tool-result--${toolCallFeedback[callKey].kind}`}>
                                    {toolCallFeedback[callKey].label}
                                  </span>
                                ) : null}
                                <button
                                  type="button"
                                  className="mabel-button mabel-button--ghost"
                                  disabled={!tool.name || !!toolCallBusy[callKey] || connector.enabled === false}
                                  title={
                                    connector.enabled === false
                                      ? "Enable this connector before running test calls"
                                      : toolSourceBySlug[connector.id] === "cache"
                                      ? "Connector is offline; reconnect to run live test calls"
                                      : "Call this tool with auto-filled required arguments"
                                  }
                                  onClick={async () => {
                                    const toolName = tool.name || "";
                                    if (!toolName) return;
                                    if (connector.enabled === false) {
                                      setErrors((prev) => ({
                                        ...prev,
                                        [connector.id]: "Connector is disabled. Enable it before running test calls.",
                                      }));
                                      return;
                                    }
                                    if (toolSourceBySlug[connector.id] === "cache") {
                                      setErrors((prev) => ({
                                        ...prev,
                                        [connector.id]: "Live MCP endpoint is unavailable right now (tools are from cache). Reconnect this connector and try again.",
                                      }));
                                      return;
                                    }
                                    const callKey = `${connector.id}::${toolName}`;
                                    const args = buildTestArgs(tool);
                                    setToolCallFeedback((prev) => {
                                      const next = { ...prev };
                                      delete next[callKey];
                                      return next;
                                    });
                                    setToolOutputOpen((prev) => {
                                      const next = { ...prev };
                                      delete next[callKey];
                                      return next;
                                    });
                                    setToolCallBusy((prev) => ({ ...prev, [callKey]: true }));
                                    try {
                                      const result = await callMcpTool(connector.id, toolName, args);
                                      setToolCallFeedback((prev) => ({ ...prev, [callKey]: summarizeToolCallResponse(result) }));
                                      setToolOutputOpen((prev) => ({ ...prev, [callKey]: false }));
                                      await (onRefreshBootstrap ?? onRefresh)();
                                      setErrors((prev) => ({ ...prev, [connector.id]: "" }));
                                    } catch (err) {
                                      const message = err instanceof Error ? err.message : "Tool call failed";
                                      if (message.includes("409") && message.toLowerCase().includes("disabled")) {
                                        await (onRefreshBootstrap ?? onRefresh)();
                                        setErrors((prev) => ({
                                          ...prev,
                                          [connector.id]: "Connector is disabled in Mabel. Enable it, then try again.",
                                        }));
                                      } else {
                                        setErrors((prev) => ({
                                          ...prev,
                                          [connector.id]: message,
                                        }));
                                      }
                                      setToolCallFeedback((prev) => ({
                                        ...prev,
                                        [callKey]: {
                                          kind: "error",
                                          label: "Failed",
                                          detail: message,
                                          output: message,
                                        },
                                      }));
                                      setToolOutputOpen((prev) => ({ ...prev, [callKey]: false }));
                                    } finally {
                                      setToolCallBusy((prev) => {
                                        const next = { ...prev };
                                        delete next[callKey];
                                        return next;
                                      });
                                    }
                                  }}
                                >
                                  {toolCallBusy[callKey] ? "Calling…" : "Test call"}
                                </button>
                                {toolCallFeedback[callKey] ? (
                                  <button
                                    type="button"
                                    className="mabel-button mabel-button--ghost"
                                    onClick={() => {
                                      setToolOutputOpen((prev) => ({ ...prev, [callKey]: !prev[callKey] }));
                                    }}
                                  >
                                    {toolOutputOpen[callKey] ? "Hide output" : "View output"}
                                  </button>
                                ) : null}
                              </div>
                              {toolOutputOpen[callKey] && toolCallFeedback[callKey]?.output ? (
                                <pre className="mabel-page__tool-output">
                                  {toolCallFeedback[callKey]?.output}
                                </pre>
                              ) : null}
                            </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
