import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultRemoteScriptRoots, resolveRuntimeConfig } from "../src/paths.mjs";

test("macOS discovery includes current Ableton User Library and app-support roots", () => {
  const roots = defaultRemoteScriptRoots({ platform: "darwin", home: "/Users/test" });
  assert.deepEqual(roots, [
    "/Users/test/Music/Ableton/User Library/Remote Scripts",
    "/Users/test/Library/Preferences/Ableton"
  ]);
});

test("runtime configuration defaults the socket and treats the catalog as optional", () => {
  const config = resolveRuntimeConfig({}, { platform: "darwin", home: "/Users/test" });
  assert.equal(config.socketPath, "/tmp/cavi-ableton-mcp.sock");
  assert.equal(config.catalogPath, undefined);
  assert.equal(config.browserMetadataPath, "/Users/test/.cavi/ableton-mcp/browser-metadata.sqlite");
});

test("server socket default matches the Remote Script default on every platform", async () => {
  const { readFile } = await import("node:fs/promises");
  const bridgeInit = await readFile(new URL("../../../ableton/Remote Scripts/CaviMcpBridge/__init__.py", import.meta.url), "utf8");
  const [, bridgeVariable, bridgeDefault] = bridgeInit.match(/os\.environ\.get\("([A-Z_]+)", "([^"]+)"\)/);
  assert.equal(bridgeVariable, "ABLETON_MCP_BRIDGE_SOCKET");
  for (const platform of ["darwin", "win32", "linux"]) {
    const config = resolveRuntimeConfig({}, { platform, home: "/Users/test" });
    assert.equal(config.socketPath, bridgeDefault, platform);
  }
});

test("the configured home anchors every per-user default", () => {
  const config = resolveRuntimeConfig({}, { platform: "darwin", home: "/Users/test" });
  assert.equal(config.confirmationDirectory, "/Users/test/.cavi/ableton-mcp/confirmations");
  assert.equal(config.snapshotDirectory, "/Users/test/.cavi/ableton-mcp/snapshots");
});

test("ABLETON_MCP_* variables override every runtime default", () => {
  const config = resolveRuntimeConfig({
    ABLETON_MCP_BRIDGE_SOCKET: "/run/bridge.sock",
    ABLETON_MCP_CATALOG_PATH: "/data/catalog.sqlite",
    ABLETON_MCP_BROWSER_METADATA_PATH: "/data/browser.sqlite",
    ABLETON_MCP_CONFIRMATION_DIR: "/data/confirmations",
    ABLETON_MCP_SNAPSHOT_DIR: "/data/snapshots"
  }, { home: "/Users/test" });
  assert.deepEqual(config, {
    socketPath: "/run/bridge.sock",
    catalogPath: "/data/catalog.sqlite",
    browserMetadataPath: "/data/browser.sqlite",
    confirmationDirectory: "/data/confirmations",
    snapshotDirectory: "/data/snapshots"
  });
});
