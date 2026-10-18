import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { createConfiguredService } from "../src/runtime.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";
import { runCli } from "../src/cli.mjs";
import { runStdio } from "../src/server.mjs";
import { PassThrough } from "node:stream";

test("producer profile exposes only compact workflows and immediate stop controls", async () => {
  const route = createRouter({ call: async () => ({}) }, { toolProfile: "producer" });
  const listed = await route({ id: 1, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), [
    "get_production_context", "run_production_task", "read_production_artifact", "record_production_note",
    "apply_production_operation", "get_producer_workflow", "get_live_state", "transport_stop", "panic",
    "start_production_session", "get_production_session", "advance_production_session"
  ].sort());
  assert.ok(Buffer.byteLength(JSON.stringify(listed.result.tools)) <= 20000);
  const denied = await route({ id: 2, method: "tools/call", params: { name: "set_tempo", arguments: { expectedStateVersion: 1, tempo: 100 } } });
  assert.equal(denied.error.code, -32601);
  assert.equal(Object.keys(toolContracts).every(name => listed.result.tools.some(tool => tool.name === name)), false);
});

test("configured service exposes producer notes without connecting to Live or a model", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "producer-integration-"));
  const runtime = createConfiguredService({ ABLETON_MCP_PRODUCER_DIR: directory, ABLETON_MCP_SPLICE_ROOTS: "[]" });
  try {
    const route=createRouter(runtime.service,{toolProfile:'producer'});
    const workflow=await route({id:1,method:'tools/call',params:{name:'get_producer_workflow',arguments:{
      workflow:'balance-mix',arguments:{request:'Lower the named bass only'}}}});
    assert.equal(workflow.result.structuredContent.workflow,'balance-mix');
    const result = await runtime.service.call("record_production_note", { projectId: "song", kind: "intent", text: "Keep the original bass." });
    assert.match(result.noteRef, /^[a-f0-9]{64}$/);
    const lines = [];
    await runCli(["call", "read_production_artifact", "--args", JSON.stringify({ projectId: "song", artifactId: result.noteRef }), "--json"], {
      runtimeFactory: () => runtime, stdout: line => lines.push(line)
    });
    assert.match(JSON.parse(lines[0]).text, /Keep the original bass/);
  } finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const name of ["run_production_task", "advance_production_session"]) test(`${name} model turns do not block stop controls on the same MCP connection`, async () => {
  const input = new PassThrough(), output = new PassThrough();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const replies = [];
  output.on("data", chunk => { for (const line of String(chunk).trim().split("\n")) replies.push(JSON.parse(line)); });
  const running = runStdio({ input, output, toolProfile: "producer", service: {
    call: async tool => tool === name ? held : { stopped: true }
  } });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name, arguments: name === "run_production_task" ? { projectId: "song", goal: "inspect" }
      : { projectId: "song", sessionId: "00000000-0000-4000-8000-000000000000", expectedRevision: 1, action: "propose" }
  } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "transport_stop", arguments: { expectedStateVersion: 1 }
  } }) + "\n");
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(replies[0]?.id, 2);
  } finally { release({ status: "proposed" }); input.end(); await running; }
});
