import type { MabelBootstrap } from "./types";

/** Connectors hidden everywhere in Mabel UI (composer, connectors page, counts). */
export const MABEL_UI_EXCLUDED_CONNECTOR_IDS = new Set([
  "remote_gateway",
  "product-usage",
  "product_usage",
]);

export function mabelUiConnectorExcluded(id: string): boolean {
  return MABEL_UI_EXCLUDED_CONNECTOR_IDS.has(id.trim().toLowerCase());
}

export function mabelUiVisibleConnectors(
  connectors: MabelBootstrap["connectors"],
): MabelBootstrap["connectors"] {
  const byId = new Map<string, MabelBootstrap["connectors"][number]>();
  for (const connector of connectors) {
    if (mabelUiConnectorExcluded(connector.id)) continue;
    const key = mabelUiCanonicalConnectorId(connector.id);
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, connector);
      continue;
    }
    const candidate = chooseBestConnectorRow(existing, connector);
    byId.set(key, candidate);
  }
  return Array.from(byId.values());
}

export function mabelUiEnabledConnectors(
  connectors: MabelBootstrap["connectors"],
): MabelBootstrap["connectors"] {
  return mabelUiVisibleConnectors(connectors).filter((connector) => connector.enabled !== false);
}

export function mabelUiConnectorToggleAllowed(id: string): boolean {
  return !mabelUiConnectorExcluded(id);
}

function mabelUiCanonicalConnectorId(id: string): string {
  const raw = id.trim().toLowerCase().replaceAll("_", "-");
  return raw === "google-analytics" ? "google-analytics-mcp" : raw;
}

function chooseBestConnectorRow(
  a: MabelBootstrap["connectors"][number],
  b: MabelBootstrap["connectors"][number],
): MabelBootstrap["connectors"][number] {
  const scoreA = connectorRank(a.connection_status, a.tool_count);
  const scoreB = connectorRank(b.connection_status, b.tool_count);
  if (scoreB > scoreA) return b;
  if (scoreA > scoreB) return a;
  // Tie-breaker: prefer explicit enabled rows and then higher tool_count.
  const enabledA = a.enabled !== false ? 1 : 0;
  const enabledB = b.enabled !== false ? 1 : 0;
  if (enabledB > enabledA) return b;
  if (enabledA > enabledB) return a;
  return (b.tool_count ?? 0) > (a.tool_count ?? 0) ? b : a;
}

function connectorRank(status: string, toolCount?: number): number {
  const tools = toolCount ?? 0;
  if (status === "connected") return 500 + tools;
  if (status === "local_package_available") return 400 + tools;
  if (status === "remote_gateway_available") return 300 + tools;
  if (status === "needs_validation") return 200 + tools;
  if (status === "not_configured") return 100 + tools;
  return tools;
}

const MABEL_UI_DISPLAY_NAME_BY_ID: Record<string, string> = {
  "google-analytics-mcp": "Google Analytics",
  "outlook-email": "Outlook Mail",
  "outlook-mail": "Outlook Mail",
  sharepoint: "Microsoft SharePoint",
  "microsoft-sharepoint": "Microsoft SharePoint",
};

const MABEL_UI_LEGACY_NAMES: Record<string, string> = {
  "Google Analytics MCP": "Google Analytics",
};

/** Whether the Connectors row shows green "Available" (matches dot), from bootstrap fields only. */
export function mabelUiConnectorIsAvailable(connector: MabelBootstrap["connectors"][number]): boolean {
  if (connector.enabled === false) return false;
  const st = connector.connection_status;
  // Live connector endpoint verified.
  if (st === "connected") return true;
  // A discovered stdio package is available only after tools/list proves runtime wiring.
  if (st === "local_package_available") return (connector.tool_count ?? 0) > 0;
  // Remote MCPs are available only after tools/list proves gateway connectivity.
  if (st === "remote_gateway_available") return (connector.tool_count ?? 0) > 0;
  return false;
}

/** Labels shown in Mabel (handles stale bootstrap `name` values). */
export function mabelUiConnectorDisplayName(id: string, name: string): string {
  const slug = id.trim().toLowerCase();
  if (MABEL_UI_DISPLAY_NAME_BY_ID[slug]) return MABEL_UI_DISPLAY_NAME_BY_ID[slug];
  const trimmed = name.trim();
  if (MABEL_UI_LEGACY_NAMES[trimmed]) return MABEL_UI_LEGACY_NAMES[trimmed];
  return name;
}
