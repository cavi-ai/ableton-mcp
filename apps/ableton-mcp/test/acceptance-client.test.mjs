import test from "node:test";
import assert from "node:assert/strict";
import { McpAcceptanceClient } from "../../../scripts/acceptance/mcp-client.mjs";
import { assertAcceptanceFixture } from "../../../scripts/acceptance/live.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("acceptance uses the actual stdio server and closes its owned process", async () => {
  const client = new McpAcceptanceClient({ env: { ...process.env, ABLETON_MCP_FIXTURE: "1" }, timeoutMs: 10000 });
  try {
    const initialized = await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "acceptance", version: "1" } });
    assert.equal(initialized.serverInfo.name, "ableton-mcp");
    const value = await client.call("list_live_scales", {});
    assert.ok(value.scales.length > 10);
    await assert.rejects(client.call("set_tempo", { tempo: "bad" }), /invalid tool arguments/);
  } finally { await client.close(); }
  assert.notEqual(client.child.exitCode, null);
});

test("a disconnected acceptance transport rejects pending calls without retrying", async () => {
  const client = new McpAcceptanceClient({ command: process.execPath, args: ["-e", "process.stdin.once('data',()=>process.exit(7))"], timeoutMs: 1000 });
  await assert.rejects(client.request("ping"), error => /exited/.test(error.message) && error.outcome === "unknown");
  await client.close();
  assert.equal(client.sentRequests, 1);
});

test("acceptance timeouts report an unknown outcome and never replay requests", async () => {
  const client = new McpAcceptanceClient({ command: process.execPath, args: ["-e", "process.stdin.resume()"], timeoutMs: 50 });
  try { await assert.rejects(client.request("tools/call", { name: "set_tempo" }), error => error.outcome === "unknown"); }
  finally { await client.close(); }
  assert.equal(client.sentRequests, 1);
});

test("acceptance refuses unsaved, mismatched and playing Sets before any fixture writes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-guard-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "scratch.als"), other = join(directory, "other.als");
  await writeFile(path, "fixture"); await writeFile(other, "other");
  assert.throws(() => assertAcceptanceFixture({ filePath: "", isPlaying: false }, path), /save/);
  assert.throws(() => assertAcceptanceFixture({ filePath: other, isPlaying: false }, path), /selected scratch/);
  assert.throws(() => assertAcceptanceFixture({ filePath: path, isPlaying: true }, path), /stopped/);
  assertAcceptanceFixture({ filePath: path, isPlaying: false }, path);
});

test("acceptance close is bounded even when its owned child ignores termination", async () => {
  const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdin.once('data',d=>{const r=JSON.parse(d);process.stdout.write(JSON.stringify({id:r.id,result:{}})+'\\n')})";
  const client = new McpAcceptanceClient({ command: process.execPath, args: ["-e", script], closeTimeoutMs: 50 });
  await client.request("ping"); await client.close();
  assert.equal(client.child.signalCode, "SIGKILL");
});
