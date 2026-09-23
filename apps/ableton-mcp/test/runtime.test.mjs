import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfiguredService } from "../src/runtime.mjs";

test("configured runtime works without an NKS catalog", () => {
  const runtime = createConfiguredService({ ABLETON_MCP_BRIDGE_SOCKET: "/tmp/test-ableton-mcp.sock" });
  assert.equal(typeof runtime.service.call, "function");
  runtime.close();
});

test("preset metadata reports when no NKS catalog is configured", async () => {
  const runtime = createConfiguredService({ ABLETON_MCP_BRIDGE_SOCKET: "/tmp/test-ableton-mcp.sock" });
  await assert.rejects(
    () => runtime.service.call("get_preset_metadata", { presetId: "serum-2:a" }),
    /preset catalog is not configured/
  );
  runtime.close();
});

test("configured runtime opens the SQLite catalog and bridge client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-runtime-"));
  const runtime = createConfiguredService({
    ABLETON_MCP_CATALOG_PATH: join(dir, "catalog.sqlite"),
    ABLETON_MCP_BRIDGE_SOCKET: join(dir, "bridge.sock")
  });
  assert.equal(typeof runtime.service.call, "function");
  assert.equal(runtime.service.bridge.socketPath, join(dir, "bridge.sock"));
  runtime.close();
});

test("configured runtime lazily opens private browser metadata at the selected path", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-browser-metadata-"));
  const runtime = createConfiguredService({ ABLETON_MCP_BROWSER_METADATA_PATH: join(dir, "browser.sqlite") });
  try {
    assert.deepEqual(runtime.service.browserMetadata().search(), []);
  } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
