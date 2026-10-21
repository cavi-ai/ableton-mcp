import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createProducerRuntime, parseProducerConfig } from "../src/producer-runtime.mjs";

const config = { type: "api-client", provider: "claude", model: "test-model", allowRemote: true };
const packet = { role: "creative", goal: "Simplify bass", context: [] };
const reply = { summary: "Try a sparse bass variation.", reads: [], operations: [], checks: [], questions: [], alternatives: [] };
const environment = { ANTHROPIC_API_KEY: "test-key" };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function stream(text = JSON.stringify(reply), terminal = true) {
  return new Response(event("message_start", { message: { id: "message-1" } }) +
    event("content_block_delta", { delta: { type: "text_delta", text } }) +
    (terminal ? event("message_stop", {}) : ""), { headers: { "Content-Type": "text/event-stream" } });
}
const runtime = (fetch, options = config, env = environment) => createProducerRuntime(options, { fetch, env });

test("API-client configuration requires an explicit provider, model and remote consent", () => {
  const parse = creative => parseProducerConfig({ ABLETON_MCP_PRODUCER_CONFIG: JSON.stringify({ creative }) });
  assert.deepEqual(parse(config), { creative: config });
  assert.deepEqual(parse({ ...config, apiKeyEnv: "SPECIALIST_KEY" }).creative.apiKeyEnv, "SPECIALIST_KEY");
  for (const invalid of [{ allowRemote: false }, { allowRemote: undefined }, { model: undefined },
    { provider: undefined }, { provider: "unknown" }, { endpoint: "https://example.com" },
    { command: "agent" }, { args: [] }, { env: [] }, { apiKey: "secret" }, { apiKeyEnv: "bad-key" }]) {
    assert.throws(() => parse({ ...config, ...invalid }), /config/);
  }
  for (const other of [{ type: "ollama", model: "local" }, { type: "acp", command: "agent" }]) {
    assert.throws(() => parse({ ...other, provider: "claude" }), /config/);
    assert.throws(() => parse({ ...other, apiKeyEnv: "KEY" }), /config/);
  }
});

test("the published client sends bounded history to the official API with no native tools or redirects", async () => {
  let calls = 0;
  const generate = runtime(async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(init.headers).get("x-api-key"), "custom-test-key");
    assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "test-model");
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.stream, true);
    assert.match(body.system, /Creative role proposes/);
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.filter(item => item.role === "assistant").length, 1);
    assert.equal(body.messages[1].content, JSON.stringify(reply));
    assert.equal(JSON.parse(body.messages.at(-1).content).progress.previousResponse, undefined);
    assert.doesNotMatch(init.body, /custom-test-key/);
    return stream();
  }, { ...config, apiKeyEnv: "SPECIALIST_KEY" }, { SPECIALIST_KEY: "custom-test-key" });
  assert.deepEqual(await generate.generate({ ...packet, progress: { turn: 2, previousResponse: reply } }), reply);
  assert.equal(calls, 1);
});

test("missing credentials, oversized input and prior cancellation fail before network access", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return stream(); };
  await assert.rejects(runtime(fetch, config, {}).generate(packet), /API key.*ANTHROPIC_API_KEY/);
  await assert.rejects(runtime(fetch).generate({ ...packet, goal: "x".repeat(48000) }), /input.*limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime(fetch).generate(packet, { signal: controller.signal }), /abort/i);
  assert.equal(calls, 0);
});

test("API responses must complete, fit the output budget and satisfy the proposal contract", async () => {
  for (const response of [() => stream(JSON.stringify(reply), false),
    () => stream("not JSON"), () => stream("x".repeat(16001)),
    () => stream(JSON.stringify({ ...reply, surprise: true })),
    () => stream(JSON.stringify({ ...reply, operations: [{ tool: "write", args: { confirmationToken: "token" } }] })),
    () => new Response(event("error", { error: { message: "private upstream diagnostics" } }))]) {
    await assert.rejects(runtime(async () => response()).generate(packet));
  }
});

test("HTTP errors are not retried or copied into specialist diagnostics", async () => {
  let calls = 0;
  await assert.rejects(runtime(async () => {
    calls++;
    return new Response("private upstream diagnostics test-key", { status: 429 });
  }).generate(packet), error => /request failed/.test(error.message) && !/private|test-key/.test(error.message));
  assert.equal(calls, 1);
});

test("the wire budget includes ignored stream frames", async () => {
  await assert.rejects(runtime(async () => new Response(event("ping", { ignored: "x".repeat(128001) })))
    .generate(packet), /byte limit/);
});

test("cancellation and deadlines stop an open response body", { timeout: 5000 }, async t => {
  for (const deadline of [false, true]) {
    const controller = new AbortController();
    const { promise: disconnected, resolve } = Promise.withResolvers();
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": connected\n\n");
      response.once("close", resolve);
      if (!deadline) setTimeout(() => controller.abort(), 20);
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const generate = runtime((url, init) => fetch(endpoint, init), { ...config, timeoutMs: 1000 });
    await assert.rejects(generate.generate(packet, { signal: controller.signal }), /abort|timeout/i);
    await disconnected;
  }
});
