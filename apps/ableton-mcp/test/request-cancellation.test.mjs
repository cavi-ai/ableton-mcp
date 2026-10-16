import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { runStdio, createRouter } from "../src/server.mjs";
import { withRequestSignal } from "../src/request-context.mjs";
import { ToolService } from "../src/tool-service.mjs";

const call = id => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_live_state", arguments: {} } });
const cancel = requestId => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });

test("stdio owns delayed errors from the final output write", async () => {
  const input = new PassThrough();
  let errorObserved = false;
  const output = new Writable({ write(_chunk, _encoding, callback) {
    setImmediate(() => callback(Object.assign(new Error("closed pipe"), { code: "EPIPE" })));
  } });
  // Observe the error without masking whether runStdio still owns the transport.
  output.on("error", () => {
    errorObserved = true;
    assert.ok(output.listenerCount("error") > 1);
  });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
  await runStdio({ input, output, service: {} });
  assert.equal(errorObserved, true);
});

test("stdio receives cancellation while the active handler is awaiting and skips queued cancelled work", async () => {
  const { requestSignal } = await import("../src/request-context.mjs");
  const input = new PassThrough(), output = new PassThrough();
  const replies = [];
  output.on("data", chunk => replies.push(...chunk.toString().trim().split("\n").map(JSON.parse)));
  const started = Promise.withResolvers();
  let calls = 0;
  const running = runStdio({ input, output, service: { call: async () => {
    calls++;
    const signal = requestSignal();
    if (calls === 1) {
      started.resolve();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return { calls };
  } } });
  input.write(`${JSON.stringify(call(1))}\n`);
  await started.promise;
  for (const request of [call(2), cancel(2), cancel(1), cancel("unknown"), call(3)])
    input.write(`${JSON.stringify(request)}\n`);
  input.end();
  await running;
  assert.equal(calls, 2);
  assert.deepEqual(replies.map(reply => reply.id), [3]);
});

test("initialize cannot be cancelled and malformed cancellation notifications get no response", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk; });
  const running = runStdio({ input, output, service: {} });
  input.end([
    { jsonrpc: "2.0", id: 1, method: "initialize" }, cancel(1),
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: {} } },
    { jsonrpc: "2.0", id: 2, method: "ping" }
  ].map(JSON.stringify).join("\n") + "\n");
  await running;
  assert.deepEqual(text.trim().split("\n").map(JSON.parse).map(reply => reply.id), [1, 2]);
});

test("tool transport failures expose structured outcome uncertainty without invalid JSON-RPC codes", async () => {
  const error = Object.assign(new Error("timed out; re-read before retrying"), {
    code: "BRIDGE_TIMEOUT", outcome: "unknown", requestIds: ["native-id"]
  });
  const route = createRouter({ call: async () => { throw error; }, readResource: async () => { throw error; } });
  const reply = await route(call(1));
  assert.equal(reply.result.isError, true);
  assert.deepEqual(reply.result.structuredContent.error, {
    code: "BRIDGE_TIMEOUT", message: error.message, outcome: "unknown", requestIds: ["native-id"]
  });
  const resource = await route({ id: 2, method: "resources/read", params: { uri: "ableton://live/status" } });
  assert.equal(typeof resource.error.code, "number");
  assert.equal(resource.error.data.outcome, "unknown");
});

test("cancellation stops Set readback polling after an already-issued host action", async () => {
  const controller = new AbortController();
  const live = { stateVersion: 1, setFingerprint: "set", filePath: "/Old.als" };
  const service = new ToolService({ bridge: { request: async () => live }, liveSetOpenTimeoutMs: 0,
    liveSetHost: { appPathFor: () => "/Live.app", fileInfo: async path => ({ path, size: 1, mtimeMs: 1 }),
      open: async () => controller.abort(new Error("cancelled")) } });
  const args = { path: "/New.als", expectedStateVersion: 1, expectedSetFingerprint: "set" };
  const planned = await service.call("open_live_set", args);
  await assert.rejects(withRequestSignal(controller.signal, () => service.call("open_live_set", { ...args,
    dryRun: false, confirmationToken: planned.confirmation.token, planHash: planned.confirmation.planHash })), /cancelled/);
});

test("cancellation during filesystem observation prevents issuing a host save", async () => {
  const controller = new AbortController();
  let observations = 0, saves = 0;
  const service = new ToolService({ liveSetSaveTimeoutMs: 0,
    bridge: { request: async () => ({ stateVersion: 1, setFingerprint: "set", filePath: "/Song.als" }) },
    liveSetHost: { appPathFor: () => "/Live.app", fileInfo: async path => {
      if (++observations === 3) controller.abort(new Error("cancelled"));
      return { path, size: 1, mtimeMs: 1 };
    }, save: async () => { saves++; } } });
  const args = { expectedStateVersion: 1, expectedSetFingerprint: "set" };
  const planned = await service.call("save_live_set", args);
  await assert.rejects(withRequestSignal(controller.signal, () => service.call("save_live_set", { ...args,
    dryRun: false, confirmationToken: planned.confirmation.token, planHash: planned.confirmation.planHash })), /cancelled/);
  assert.equal(saves, 0);
});

test("a lost output transport aborts active work and never starts queued handlers", { timeout: 2000 }, async () => {
  const { requestSignal } = await import("../src/request-context.mjs");
  const input = new PassThrough(), output = new PassThrough();
  const started = Promise.withResolvers();
  let calls = 0;
  const running = runStdio({ input, output, service: { call: async () => {
    calls++;
    started.resolve();
    const signal = requestSignal();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } } });
  input.write(`${JSON.stringify(call(1))}\n`);
  await started.promise;
  input.write(`${JSON.stringify(call(2))}\n`);
  output.destroy();
  input.end();
  await running;
  assert.equal(calls, 1);
});
