import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createProducerRuntime, parseProducerConfig } from "../src/producer-runtime.mjs";

const reply = { summary: "Try a sparse bass variation.", reads: [], operations: [], checks: [], questions: [], alternatives: [] };
const packet = { role: "creative", goal: "Simplify bass", context: [] };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const json = value => Response.json(value);
const configs = {
  codex: { model: "test-model" },
  openclaw: { endpoint: "ws://127.0.0.1:18789", agentId: "specialist" },
  hermes: { endpoint: "http://127.0.0.1:8642", agentId: "specialist" },
  opencode: { endpoint: "http://127.0.0.1:4096", model: "provider/model", directory: "/specialist" },
  agy: { endpoint: "http://127.0.0.1:8045", model: "specialist" }
};
const config = (provider, extra = {}) => ({ type: "api-client", provider, allowRemote: true, ...configs[provider], ...extra });

test("each API-client provider validates its own credentials, endpoint, model or agent scope", () => {
  const parse = value => parseProducerConfig({ ABLETON_MCP_PRODUCER_CONFIG: JSON.stringify({ functional: value }) });
  for (const provider of Object.keys(configs)) assert.deepEqual(parse(config(provider)).functional, config(provider));
  for (const [provider, extra] of [["codex", { endpoint: "https://example.com" }],
    ["openclaw", { agentId: undefined }], ["hermes", { model: "ignored" }],
    ["opencode", { model: "missing-provider" }], ["opencode", { directory: " " }],
    ["agy", { endpoint: "http://remote.example" }], ["hermes", { endpoint: "https://user:key@example.com" }],
    ["openclaw", { endpoint: "wss://example.com/?token=secret" }], ["agy", { directory: "/ignored" }]]) {
    assert.throws(() => parse(config(provider, extra)), /config/);
  }
});

test("Codex retrieves a completed background response without duplicating assistant history", async () => {
  const calls = [];
  const runtime = createProducerRuntime(config("codex"), { env: { OPENAI_API_KEY: "test-key" }, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-key");
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.background, true); assert.equal(body.store, true);
      assert.equal(body.tools, undefined);
      assert.equal(body.input.filter(message => message.role === "assistant").length, 1);
      assert.equal(JSON.parse(body.input.at(-1).content).progress.previousResponse, undefined);
      return json({ id: "resp_test", status: "queued" });
    }
    assert.equal(String(url), "https://api.openai.com/v1/responses/resp_test");
    return json({ id: "resp_test", status: "completed", output_text: JSON.stringify(reply) });
  } });
  assert.deepEqual(await runtime.generate({ ...packet, progress: { turn: 2, previousResponse: reply } }), reply);
  assert.equal(calls.length, 2);
});

test("Codex cancellation attempts to stop only the owned run with an independent deadline", async () => {
  const controller = new AbortController(); let cancelled = false;
  const runtime = createProducerRuntime(config("codex"), { env: { OPENAI_API_KEY: "test-key" }, fetch: async (url, init) => {
    if (String(url).endsWith("/cancel")) {
      assert.equal(String(url), "https://api.openai.com/v1/responses/resp_owned/cancel");
      assert.equal(init.signal.aborted, false); cancelled = true;
      return json({ id: "resp_owned", status: "cancelled" });
    }
    if (init.method === "POST") return json({ id: "resp_owned", status: "queued" });
    controller.abort(); throw controller.signal.reason;
  } });
  await assert.rejects(runtime.generate(packet, { signal: controller.signal }), /abort/i);
  assert.equal(cancelled, true);
});

test("Codex rejects foreign run identities, missing output and failed outcomes", async () => {
  for (const result of [{ id: "resp_foreign", status: "completed", output_text: JSON.stringify(reply) },
    { id: "resp_owned", status: "completed" }, { id: "resp_owned", status: "failed" },
    { id: "resp_owned", status: "incomplete" }, { id: "resp_owned", status: "completed", output_text: "invalid JSON" }]) {
    const stops = [];
    const runtime = createProducerRuntime(config("codex"), { env: { OPENAI_API_KEY: "test-key" }, fetch: async (url, init) => {
      if (String(url).endsWith("/cancel")) { stops.push(String(url)); return json({ status: "cancelled" }); }
      return json(init.method === "POST" ? { id: "resp_owned", status: "queued" } : result);
    } });
    await assert.rejects(runtime.generate(packet));
    assert.ok(stops.every(url => url.endsWith("/resp_owned/cancel")));
  }
});

test("Hermes routes a fresh session to the named agent and collects canonical SSE output", async () => {
  const sessions = [];
  const runtime = createProducerRuntime(config("hermes"), { env: { HERMES_API_KEY: "test-key" }, fetch: async (url, init) => {
    assert.equal(init.redirect, "error");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key");
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.targetAgent, "specialist");
      assert.equal(body.sessionKey, headers.get("x-hermes-session-key"));
      assert.match(body.input, /Creative role proposes/);
      sessions.push(body.sessionKey);
      return json({ run_id: "run-hermes" });
    }
    assert.match(String(url), /run-hermes/);
    assert.equal(headers.get("x-hermes-session-key"), sessions.at(-1));
    return new Response(event("message.delta", { event: "message.delta", run_id: "run-hermes", delta: JSON.stringify(reply) }) +
      event("run.completed", { event: "run.completed", run_id: "run-hermes", output: JSON.stringify(reply) }),
    { headers: { "Content-Type": "text/event-stream" } });
  } });
  assert.deepEqual(await runtime.generate(packet), reply);
  assert.deepEqual(await runtime.generate(packet), reply);
  assert.notEqual(sessions[0], sessions[1]);
});

test("Hermes cancellation disposes SSE and stops the same run with its session header", async () => {
  const controller = new AbortController(); let sessionKey; let stopped = false; let disposed = false;
  const runtime = createProducerRuntime(config("hermes"), { env: { HERMES_API_KEY: "test-key" }, fetch: async (url, init) => {
    if (String(url).endsWith("/stop")) {
      assert.equal(new Headers(init.headers).get("x-hermes-session-key"), sessionKey);
      assert.equal(init.signal.aborted, false); stopped = true; return json({ status: "cancelled" });
    }
    if (init.method === "POST") { sessionKey = JSON.parse(init.body).sessionKey; return json({ run_id: "run-owned" }); }
    setTimeout(() => controller.abort(), 20);
    return new Response(new ReadableStream({ cancel() { disposed = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  await assert.rejects(runtime.generate(packet, { signal: controller.signal }), /abort/i);
  assert.equal(stopped, true); assert.equal(disposed, true);
});

test("Hermes rejects approvals, foreign run output and streams without terminal completion", async () => {
  for (const events of [event("approval.request", { event: "approval.request", run_id: "run-owned", approval_id: "approval" }),
    event("run.completed", { event: "run.completed", run_id: "foreign", output: JSON.stringify(reply) }),
    event("message.delta", { event: "message.delta", delta: JSON.stringify(reply) })]) {
    let stopped = false;
    const runtime = createProducerRuntime(config("hermes"), { env: { HERMES_API_KEY: "test-key" }, fetch: async (url, init) => {
      if (String(url).endsWith("/stop")) { stopped = true; return json({ status: "cancelled" }); }
      return init.method === "POST" ? json({ run_id: "run-owned" }) : new Response(events, { headers: { "Content-Type": "text/event-stream" } });
    } });
    await assert.rejects(runtime.generate(packet));
    assert.equal(stopped, true);
  }
});

test("OpenCode scopes a fresh session and prompt to the configured directory and model", async () => {
  const calls = []; let output;
  const runtime = createProducerRuntime(config("opencode"), { env: { OPENCODE_SERVER_PASSWORD: "test-password" }, fetch: async (input, init) => {
    const url = new URL(input); calls.push(url.pathname);
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Basic ${Buffer.from("opencode:test-password").toString("base64")}`);
    if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.27" });
    assert.equal(url.searchParams.get("directory"), "/specialist");
    if (url.pathname === "/session") return json({ id: "ses_owned", directory: "/specialist", version: "1.18.27" });
    if (url.pathname === "/event") return new Response(new ReadableStream({ start(controller) { output = controller; } }),
      { headers: { "Content-Type": "text/event-stream" } });
    assert.equal(url.pathname, "/session/ses_owned/prompt_async");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.model, { providerID: "provider", modelID: "model" });
    assert.match(body.system, /Creative role proposes/);
    assert.equal(JSON.parse(body.parts[0].text).at(-1).role, "user");
    setTimeout(() => {
      output.enqueue(new TextEncoder().encode(event("message", { type: "message.part.delta", properties: {
        sessionID: "ses_owned", messageID: "message_1", partID: "part_1", field: "text", delta: JSON.stringify(reply)
      } }) + event("message", { type: "message.updated", properties: {
        sessionID: "ses_owned", info: { id: "message_1", sessionID: "ses_owned", role: "assistant", time: { completed: 1 } }
      } })));
    }, 0);
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(await runtime.generate(packet), reply);
  assert.deepEqual(calls, ["/global/health", "/session", "/event", "/session/ses_owned/prompt_async"]);
});

test("OpenCode cancellation aborts only its created session", async () => {
  const controller = new AbortController();
  const { promise: stopped, resolve } = Promise.withResolvers();
  const runtime = createProducerRuntime(config("opencode"), { env: {}, fetch: async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.27" });
    if (url.pathname === "/session") return json({ id: "ses_owned", directory: "/specialist", version: "1.18.27" });
    if (url.pathname === "/session/ses_owned/abort") {
      assert.equal(url.searchParams.get("directory"), "/specialist");
      assert.equal(init.signal.aborted, false); resolve(); return json(true);
    }
    if (url.pathname === "/event") return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
    assert.equal(url.pathname, "/session/ses_owned/prompt_async");
    setTimeout(() => controller.abort(), 20);
    return new Response(null, { status: 204 });
  } });
  await assert.rejects(runtime.generate(packet, { signal: controller.signal }), /abort/i);
  await Promise.race([stopped, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenCode abort missing")), 1000); timer.unref();
  })]);
});

test("AGY maps the configured agent and accepts only a completed text result", async () => {
  const runtime = createProducerRuntime(config("agy"), { env: { AGY_API_KEY: "test-key" }, fetch: async (url, init) => {
    assert.equal(new Headers(init.headers).get("x-agy-api-key"), "test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.agent_id, "specialist");
    assert.match(body.instructions, /Creative role proposes/);
    return new Response(event("message", { status: "completed", result: { output: JSON.stringify(reply) } }));
  } });
  assert.deepEqual(await runtime.generate(packet), reply);
});

async function openClawServer(t, respond) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "challenge", ts: Date.now() } }));
    socket.on("message", bytes => {
      const request = JSON.parse(String(bytes));
      const reply = payload => socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
      if (request.method === "connect") {
        assert.equal(request.params.auth.token, "test-key");
        assert.ok(request.params.scopes.includes("operator.write"));
        reply({ type: "hello-ok", protocol: request.params.maxProtocol });
      } else respond(request, reply, socket);
    });
  });
  return `ws://127.0.0.1:${server.address().port}`;
}

test("OpenClaw uses native RPC, correlates final output and closes its owned connection", async t => {
  const sessions = [];
  const endpoint = await openClawServer(t, (request, acknowledge, socket) => {
    assert.equal(request.method, "chat.send");
    assert.equal(request.params.deliver, false);
    assert.match(request.params.message, /Creative role proposes/);
    assert.match(request.params.sessionKey, /^agent:specialist:/);
    sessions.push(request.params.sessionKey);
    socket.send(JSON.stringify({ type: "event", event: "chat", payload: { runId: "run-owned", sessionKey: request.params.sessionKey,
      state: "delta", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(reply) }] } } }));
    // Final output may arrive before the acknowledgement; an unrelated run is ignored.
    for (const [runId, sessionKey, text] of [["foreign", "agent:other:session", "wrong output"],
      ["run-owned", request.params.sessionKey, JSON.stringify(reply)]]) socket.send(JSON.stringify({ type: "event", event: "chat",
      payload: { runId, sessionKey, state: "final", ...(sessions.length === 1 ? { message: { role: "assistant", content: [{ type: "text", text }] } } : {}) } }));
    socket.send(JSON.stringify({ type: "event", event: "chat", payload: { runId: "run-owned", sessionKey: request.params.sessionKey,
      state: "final", message: { role: "assistant", content: "ignore this duplicate terminal" } } }));
    acknowledge({ runId: "run-owned", status: "started" });
  });
  const runtime = createProducerRuntime(config("openclaw", { endpoint }), { env: { OPENCLAW_GATEWAY_TOKEN: "test-key" } });
  assert.deepEqual(await runtime.generate(packet), reply);
  assert.deepEqual(await runtime.generate(packet), reply);
  assert.notEqual(sessions[0], sessions[1]);
});

test("OpenClaw cancellation sends an abort for the owned run and closes the connection", async t => {
  const controller = new AbortController(); let stopped = false;
  const endpoint = await openClawServer(t, (request, acknowledge) => {
    if (request.method === "chat.send") { acknowledge({ runId: "run-owned", status: "started" }); setTimeout(() => controller.abort(), 20); }
    else { assert.equal(request.method, "sessions.abort"); assert.equal(request.params.runId, "run-owned"); stopped = true; acknowledge({ aborted: true }); }
  });
  const runtime = createProducerRuntime(config("openclaw", { endpoint }), { env: { OPENCLAW_GATEWAY_TOKEN: "test-key" } });
  await assert.rejects(runtime.generate(packet, { signal: controller.signal }), /abort/i);
  assert.equal(stopped, true);
});
