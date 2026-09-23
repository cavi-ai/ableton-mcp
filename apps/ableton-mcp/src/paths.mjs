import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform as currentPlatform } from "node:os";

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;

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
    socketPath: environment.ABLETON_MCP_BRIDGE_SOCKET || "/tmp/cavi-ableton-mcp.sock",
    catalogPath: environment.ABLETON_MCP_CATALOG_PATH || undefined,
    browserMetadataPath: environment.ABLETON_MCP_BROWSER_METADATA_PATH || join(home, ".cavi", "ableton-mcp", "browser-metadata.sqlite"),
    confirmationDirectory: environment.ABLETON_MCP_CONFIRMATION_DIR || join(home, ".cavi", "ableton-mcp", "confirmations"),
    snapshotDirectory: environment.ABLETON_MCP_SNAPSHOT_DIR || join(home, ".cavi", "ableton-mcp", "snapshots")
  };
}

export function isMainModule(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); }
  catch { return false; }
}
