import { join } from "node:path";
import { homedir, platform as currentPlatform, tmpdir as currentTmpdir } from "node:os";

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
  const platform = options.platform || currentPlatform();
  const temp = options.tmpdir || currentTmpdir();
  const socketRoot = platform === "win32" ? temp : "/tmp";
  return {
    socketPath: environment.CAVI_MCP_BRIDGE_SOCKET || join(socketRoot, "cavi-ableton-mcp.sock"),
    kompleteSocketPath: environment.KOMPLETE_AUTOMATION_SOCKET || join(socketRoot, "cavi-komplete-automation.sock"),
    catalogPath: environment.ABLETON_NKS_CATALOG_PATH || undefined
  };
}
