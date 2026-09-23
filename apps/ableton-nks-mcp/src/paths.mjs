import { join } from "node:path";
import { homedir, platform as currentPlatform } from "node:os";

export function defaultRemoteScriptRoots({ platform = currentPlatform(), home = homedir() } = {}) {
  if (platform === "darwin") {
    return [
      join(home, "Music", "Ableton", "User Library", "Remote Scripts"),
      join(home, "Library", "Preferences", "Ableton")
    ];
  }
  if (platform === "win32") {
    return [join(home, "Documents", "Ableton", "User Library", "Remote Scripts")];
  }
  return [join(home, "Ableton", "User Library", "Remote Scripts")];
}

export function resolveRuntimeConfig(environment = process.env, options = {}) {
  const home = options.home || homedir();
  return {
    socketPath: environment.CAVI_MCP_BRIDGE_SOCKET || "/tmp/cavi-ableton-mcp.sock",
    kompleteSocketPath: environment.KOMPLETE_AUTOMATION_SOCKET || "/tmp/cavi-komplete-automation.sock",
    catalogPath: environment.ABLETON_NKS_CATALOG_PATH || undefined,
    browserMetadataPath: environment.CAVI_MCP_BROWSER_METADATA_PATH || join(home, ".cavi", "ableton-mcp", "browser-metadata.sqlite"),
    confirmationDirectory: environment.CAVI_MCP_CONFIRMATION_DIR || join(home, ".cavi", "ableton-mcp", "confirmations"),
    snapshotDirectory: environment.CAVI_MCP_SNAPSHOT_DIR || join(home, ".cavi", "ableton-mcp", "snapshots")
  };
}
