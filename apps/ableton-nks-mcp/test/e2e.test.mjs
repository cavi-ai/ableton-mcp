import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnixBridgeClient } from "../src/bridge-client.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";
import { startMockBridge } from "./fixtures/mock-bridge.mjs";

test("MCP router executes a confirmed mutation through the Unix bridge once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ableton-mcp-"));
  const socketPath = join(dir, "bridge.sock");
  const server = await startMockBridge(socketPath);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const bridge = new UnixBridgeClient(socketPath);
  const catalog = { search: () => [] };
  const route = createRouter(new ToolService({ bridge, catalog }));
  const args = { trackId: "t1", deviceId: "d1", expectedStateVersion: 4, changes: [{ id: "cutoff", value: 0.75 }] };
  const dry = await route({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_device_parameters", arguments: args } });
  const planned = dry.result.structuredContent;
  assert.equal(planned.dryRun, true);
  const confirmedArgs = { ...args, dryRun: false, confirmationToken: planned.confirmation.token, planHash: planned.confirmation.planHash };
  const live = await route({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_device_parameters", arguments: confirmedArgs } });
  assert.equal(live.result.structuredContent.observed.stateVersion, 5);
  const replay = await route({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "set_device_parameters", arguments: confirmedArgs } });
  assert.match(replay.error.message, /unknown confirmation token/);
});
