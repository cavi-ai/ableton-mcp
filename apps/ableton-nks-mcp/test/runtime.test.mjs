import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfiguredService } from "../src/runtime.mjs";

test("configured runtime works without the private catalog", () => {
  const runtime = createConfiguredService({ CAVI_MCP_BRIDGE_SOCKET: "/tmp/test-ableton-mcp.sock" });
  assert.equal(typeof runtime.service.call, "function");
  runtime.close();
});

test("preset metadata reports when the private catalog is not configured", async () => {
  const runtime = createConfiguredService({ CAVI_MCP_BRIDGE_SOCKET: "/tmp/test-ableton-mcp.sock" });
  await assert.rejects(
    () => runtime.service.call("get_preset_metadata", { presetId: "serum-2:a" }),
    /preset catalog is not configured/
  );
  runtime.close();
});

test("configured runtime opens the SQLite catalog and bridge client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-runtime-"));
  const runtime = createConfiguredService({
    ABLETON_NKS_CATALOG_PATH: join(dir, "catalog.sqlite"),
    CAVI_MCP_BRIDGE_SOCKET: join(dir, "bridge.sock"),
    KOMPLETE_AUTOMATION_SOCKET: join(dir, "komplete.sock")
  });
  assert.equal(typeof runtime.service.call, "function");
  assert.equal(runtime.service.komplete.socketPath, join(dir, "komplete.sock"));
  runtime.close();
});
