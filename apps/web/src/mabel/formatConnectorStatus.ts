/** Human-readable labels for `MabelBootstrap.connectors[].connection_status`. */

export function formatMabelConnectorConnectionStatus(
  connectionStatus: string,
  _options: { toolCount: number },
): string {
  switch (connectionStatus) {
    case "connected":
      return "Live (local MCP)";
    case "remote_gateway_available":
      return "Vendor (Remote Gateway)";
    case "local_package_available":
      return "Local package (add endpoint)";
    case "needs_validation":
      return "Needs validation";
    case "not_configured":
      return "Not configured";
    default:
      return connectionStatus.replace(/_/g, " ");
  }
}
