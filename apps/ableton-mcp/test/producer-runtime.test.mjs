import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProducerRuntime, parseProducerConfig } from "../src/producer-runtime.mjs";

const reply = { summary: "Try a sparse bass variation.", reads: [], operations: [], checks: [], questions: [], alternatives: [] };
const packet = { role: "creative", goal: "Simplify bass", context: [] };

test("runtime config is explicit, role specific, and rejects unknown or unsafe settings", () => {
  assert.equal(parseProducerConfig({}), null);
  const config = { creative: { type: "ollama", model: "local-model" }, functional: { type: "acp", command: "agent", args: [] } };
  assert.deepEqual(parseProducerConfig({ ABLETON_MCP_PRODUCER_CONFIG: JSON.stringify(config) }).creative, config.creative);
  for (const value of [{ creative: { type: "unknown" } }, { creative: { type: "ollama" } },
    { creative: { type: "ollama", model: "x", endpoint: "https://remote.example" } },
    { creative: { type: "acp", command: "agent", env: { SECRET: "value" } } },
    { creative: { type: "ollama", model: "gpt-oss:120b-cloud" } }, { surprise: true }]) {
    assert.throws(() => parseProducerConfig({ ABLETON_MCP_PRODUCER_CONFIG: JSON.stringify(value) }), /config|endpoint/);
  }
});

test("Ollama sends only the bounded task, requests structured output and validates it", async t => {
  let body;
  const server = createServer(async (req, res) => {
    let data = ""; for await (const chunk of req) data += chunk;
    if (req.url === "/api/show") { res.end(JSON.stringify({ details: { format: "gguf" }, modelfile: "FROM local-file" })); return; }
    body = JSON.parse(data);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: { content: JSON.stringify(reply) } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const runtime = createProducerRuntime({ type: "ollama", model: "test-model", endpoint: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual(await runtime.generate(packet), reply);
  assert.equal(body.stream, false);
  assert.equal(body.model, "test-model");
  assert.equal(body.format.type, "object");
  assert.equal(body.messages.length, 2);
  assert.deepEqual(JSON.parse(body.messages[1].content), packet);
  await assert.rejects(runtime.generate({ ...packet, goal: "a".repeat(70000) }), /input.*limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.generate(packet, { signal: controller.signal }), /abort/i);
});

test("ACP negotiates v1, isolates its session, denies permissions and ignores thought streams", async t => {
  const directory = await mkdtemp(join(tmpdir(), "producer-acp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "agent.mjs");
  await writeFile(script, `import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let promptId;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize') {
  if(JSON.stringify(m.params.clientCapabilities)!=='{}') process.exit(7);
  send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 } else if(m.method==='session/new') {
  if(m.params.mcpServers.length || m.params.cwd!==${JSON.stringify(directory)}) process.exit(8);
  send({id:m.id,result:{sessionId:'isolated'}});
 } else if(m.method==='session/prompt') {
  promptId=m.id;
  send({method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'wrong session'}}}});
  send({method:'session/update',params:{sessionId:'isolated',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private reasoning'}}}});
  send({id:900,method:'session/request_permission',params:{sessionId:'isolated',options:[]}});
 } else if(m.id===900) {
  if(m.result.outcome.outcome!=='cancelled') process.exit(9);
  send({method:'session/update',params:{sessionId:'isolated',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(JSON.stringify(reply))}}}}});
  send({id:promptId,result:{stopReason:'end_turn'}});
 }
}`);
  const runtime = createProducerRuntime({ type: "acp", command: process.execPath, args: [script] });
  assert.deepEqual(await runtime.generate(packet, { cwd: directory }), reply);
});

test("runtime rejects malformed, oversized, and authority-bearing output", async () => {
  for (const value of ["not json", JSON.stringify({ ...reply, summary: "x".repeat(20000) }),
    JSON.stringify({ ...reply, operations: [{ tool: "set_tempo", args: { tempo: 120, confirmationToken: "secret" } }] }),
    JSON.stringify({ ...reply, extra: true })]) {
    const runtime = createProducerRuntime({ type: "ollama", model: "x" }, { fetch: async url => new Response(JSON.stringify(String(url).endsWith("/api/show")
      ? { details: { format: "gguf" }, modelfile: "FROM local-file" } : { message: { content: value } })) });
    await assert.rejects(runtime.generate(packet), /JSON|output|confirmation|schema/);
  }
});

test("Ollama cloud aliases fail before project context is transmitted", async () => {
  let requests = 0;
  const runtime = createProducerRuntime({ type: "ollama", model: "my-alias" }, { fetch: async url => {
    requests++; assert.match(String(url), /api\/show$/);
    return new Response(JSON.stringify({ details: { format: "", parent_model: "cloud-model" } }));
  } });
  await assert.rejects(runtime.generate(packet), /local model|remote/);
  assert.equal(requests, 1);
});

test("ACP cancellation terminates an owned launcher and its inherited-pipe descendant", async t => {
  if (process.platform === "win32") return t.skip("POSIX process-group ownership test");
  const directory = await mkdtemp(join(tmpdir(), "producer-acp-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "launcher.mjs");
  await writeFile(script, `import {spawn} from 'node:child_process';
spawn(process.execPath,['-e','setTimeout(()=>{},1800)'],{stdio:['ignore',process.stdout,process.stderr]});
setTimeout(()=>{},1800);`);
  const runtime = createProducerRuntime({ type: "acp", command: process.execPath, args: [script] });
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(new Error("cancelled")), 150);
  try { await assert.rejects(runtime.generate(packet, { signal: controller.signal, cwd: directory }), /cancelled/); }
  finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 1400, "teardown waited for inherited descendant pipes");
});
