/** Short one-line MCP tool descriptions for the Connectors UI. */

const MAX_TOOL_DESCRIPTION_CHARS = 72;

const CONNECTOR_LABELS: Record<string, string> = {};

function connectorDisplayLabel(serverSlug: string): string {
  const slug = serverSlug.trim().toLowerCase();
  if (CONNECTOR_LABELS[slug]) return CONNECTOR_LABELS[slug];
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function stripConnectorPrefix(toolName: string, serverSlug: string): string {
  const name = toolName.trim();
  const slug = serverSlug.trim().toLowerCase();
  if (!name || !slug) return name;
  const variants = [slug, slug.replace(/-/g, "_"), slug.replace(/_/g, "-")];
  const lowered = name.toLowerCase();
  for (const variant of variants) {
    for (const prefix of [`${variant}_`, `${variant}-`]) {
      if (lowered.startsWith(prefix)) return name.slice(prefix.length);
    }
  }
  return name;
}

function inferToolDescription(toolName: string, serverSlug: string): string {
  const display = connectorDisplayLabel(serverSlug);
  const words = stripConnectorPrefix(toolName, serverSlug).replace(/_/g, " ").trim();
  const lower = words.toLowerCase();

  if (!words) return `${display} MCP tool.`;
  if (lower === "health" || lower === "health check" || lower.endsWith("health check")) {
    return `${display} MCP and upstream health check.`;
  }
  if (lower.startsWith("get ")) return `Fetch ${words.slice(4)} from ${display}.`;
  if (lower.startsWith("list ")) return `List ${words.slice(5)} from ${display}.`;
  if (lower.startsWith("search ")) return `Search ${words.slice(7)} via ${display}.`;
  if (lower.startsWith("calculate ")) return `Calculate ${words.slice(10)} via ${display}.`;
  if (lower.startsWith("find ")) return `Find ${words.slice(5)} via ${display}.`;
  if (lower === "chat" || lower.startsWith("chat ")) return `Chat with ${display}.`;

  return `${words.charAt(0).toUpperCase()}${words.slice(1)} via ${display}.`;
}

function compactToolDescription(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text || text.length <= MAX_TOOL_DESCRIPTION_CHARS) return text;
  const clipped = text.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1).replace(/\s+\S*$/, "");
  return `${clipped || text.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1)}…`;
}

export function mabelMcpToolDescription(toolName: string, serverSlug: string, rawDescription?: string): string {
  const raw = typeof rawDescription === "string" ? rawDescription.replace(/\s+/g, " ").trim() : "";
  if (raw && raw.length <= MAX_TOOL_DESCRIPTION_CHARS) return raw;
  return compactToolDescription(inferToolDescription(toolName, serverSlug));
}
