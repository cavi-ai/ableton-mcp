import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
  let spliceRoots = [];
  if (environment.ABLETON_MCP_SPLICE_ROOTS !== undefined) {
    try { spliceRoots = JSON.parse(environment.ABLETON_MCP_SPLICE_ROOTS); }
    catch { throw new Error("ABLETON_MCP_SPLICE_ROOTS must be a JSON array of absolute paths"); }
    if (!Array.isArray(spliceRoots) || spliceRoots.some(path => typeof path !== "string" || !isAbsolute(path)))
      throw new Error("ABLETON_MCP_SPLICE_ROOTS must be a JSON array of absolute paths");
    spliceRoots = spliceRoots.map(path => resolve(path));
    if (new Set(spliceRoots).size !== spliceRoots.length)
      throw new Error("ABLETON_MCP_SPLICE_ROOTS must contain distinct paths");
  }
  return {
    socketPath: environment.ABLETON_MCP_BRIDGE_SOCKET || "/tmp/cavi-ableton-mcp.sock",
    catalogPath: environment.ABLETON_MCP_CATALOG_PATH || undefined,
    browserMetadataPath: environment.ABLETON_MCP_BROWSER_METADATA_PATH || join(home, ".cavi", "ableton-mcp", "browser-metadata.sqlite"),
    spliceRoots,
    confirmationDirectory: environment.ABLETON_MCP_CONFIRMATION_DIR || join(home, ".cavi", "ableton-mcp", "confirmations"),
    snapshotDirectory: environment.ABLETON_MCP_SNAPSHOT_DIR || join(home, ".cavi", "ableton-mcp", "snapshots")
  };
}

export function isMainModule(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); }
  catch { return false; }
}
