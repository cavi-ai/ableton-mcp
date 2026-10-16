import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixBridgeClient } from "../src/bridge-client.mjs";
import { decodeBridgeLines, encodeBridgeMessage } from "../src/bridge-protocol.mjs";

async function listener(t, receive) {
  const directory = await mkdtemp(join(tmpdir(), "ab-batch-"));
  const path = join(directory, "bridge.sock");
  const clients = new Set();
  let connections = 0;
  const server = createServer(socket => {
    connections++;
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      const decoded = decodeBridgeLines(Buffer.concat([buffer, chunk]));
      buffer = decoded.remainder;
      for (const request of decoded.messages) {
        if (request.method === "get_bridge_protocol") socket.write(encodeBridgeMessage({ id: request.id,
          result: { version: 2, requestDeadlines: true, requestCancellation: true } }));
        else receive(socket, request);
      }
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(path, resolve));
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { client: new UnixBridgeClient(path, { timeoutMs: 1000 }), connections: () => connections };
}

test("batch reads share one connection and preserve order across fragmented reversed replies", async t => {
  const received = [];
  const { client, connections } = await listener(t, (socket, request) => {
    received.push(request);
    if (received.length !== 4) return;
    const replies = received.toReversed().map(item => encodeBridgeMessage({ id: item.id,
      result: { method: item.method, params: item.params } }));
    socket.write(replies[0].subarray(0, 7));
    setImmediate(() => socket.write(Buffer.concat([replies[0].subarray(7), ...replies.slice(1)])));
  });
  const requests = Array.from({ length: 4 }, (_, index) => ({ method: `read_${index}`, params: { index } }));
  assert.deepEqual(await client.requestMany(requests), requests);
  assert.equal(connections(), 1);
  assert.equal(new Set(received.map(request => request.id)).size, 4);
});

test("a batch error rejects the read and subsequent single requests remain fresh", async t => {
  const { client } = await listener(t, (socket, request) => socket.write(encodeBridgeMessage(
    request.method === "fail" ? { id: request.id, error: { message: "native read failed" } }
      : { id: request.id, result: { stateVersion: request.params.version } }
  )));
  await assert.rejects(client.requestMany([{ method: "ok", params: { version: 1 } }, { method: "fail" }]),
    /native read failed/);
  assert.deepEqual(await client.request("ok", { version: 2 }), { stateVersion: 2 });
});

test("incomplete batch replies reject when the peer closes", async t => {
  const { client } = await listener(t, (socket, request) => {
    if (request.method === "first") socket.end(encodeBridgeMessage({ id: request.id, result: {} }));
  });
  await assert.rejects(client.requestMany([{ method: "first" }, { method: "second" }]), /closed/);
});

test("malformed bridge frames reject the request instead of escaping the data handler", async t => {
  const { client } = await listener(t, socket => socket.end("not-json\n"));
  await assert.rejects(client.requestMany([{ method: "read" }]), /JSON|Unexpected token/);
});

test("missing batch replies time out and close their connection", async t => {
  const { client } = await listener(t, () => {});
  client.timeoutMs = 100;
  await assert.rejects(client.requestMany([{ method: "read" }]), /bridge request timed out/);
});

test("requests carry a bounded deadline and timeout sends connection-scoped cancellation", async t => {
  const received = [];
  let cancellation;
  const cancelled = new Promise(resolve => { cancellation = resolve; });
  const { client } = await listener(t, (_socket, request) => {
    received.push(request);
    if (request.cancelRequestIds) cancellation(request);
  });
  client.timeoutMs = 100;
  const started = Date.now();
  await assert.rejects(client.request("set_tempo", { tempo: 130 }), error => {
    assert.equal(error.code, "BRIDGE_TIMEOUT");
    assert.equal(error.outcome, "unknown");
    assert.match(error.message, /read.*before.*retry/i);
    return true;
  });
  const frame = await cancelled;
  assert.deepEqual(frame.cancelRequestIds, [received[0].id]);
  assert.ok(received[0].deadlineUnixMs >= started);
  assert.ok(received[0].deadlineUnixMs <= started + 100);
});

test("an already aborted request opens no connection and reports not executed", async t => {
  const { client, connections } = await listener(t, () => assert.fail("must not send"));
  await assert.rejects(client.request("set_tempo", {}, { signal: AbortSignal.abort() }), error => {
    assert.equal(error.code, "BRIDGE_CANCELLED");
    assert.equal(error.outcome, "not_executed");
    return true;
  });
  assert.equal(connections(), 0);
});

test("cancellation after transmission is honest and does not poison subsequent requests", async t => {
  const controller = new AbortController();
  const { client } = await listener(t, (socket, request) => {
    if (request.method === "set_tempo") controller.abort();
    if (request.method === "get_live_state") socket.write(encodeBridgeMessage({ id: request.id, result: { tempo: 120 } }));
  });
  await assert.rejects(client.request("set_tempo", {}, { signal: controller.signal }), error => {
    assert.equal(error.code, "BRIDGE_CANCELLED");
    assert.equal(error.outcome, "unknown");
    return true;
  });
  assert.deepEqual(await client.request("get_live_state"), { tempo: 120 });
});

test("native expiry is distinguishable from an uncertain transport failure", async t => {
  const { client } = await listener(t, (socket, request) => socket.write(encodeBridgeMessage({ id: request.id,
    error: { code: "BRIDGE_EXPIRED", message: "request expired before execution", outcome: "not_executed" } })));
  await assert.rejects(client.request("set_tempo"), error => {
    assert.equal(error.code, "BRIDGE_EXPIRED");
    assert.equal(error.outcome, "not_executed");
    return true;
  });
});

test("an older bridge is refused before transmitting the requested operation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ab-old-"));
  const path = join(directory, "bridge.sock");
  const methods = [];
  const server = createServer(socket => {
    socket.on("error", () => {});
    socket.on("data", chunk => {
      for (const request of decodeBridgeLines(chunk).messages) {
        methods.push(request.method);
        socket.write(encodeBridgeMessage({ id: request.id, error: { message: "unsupported method get_bridge_protocol" } }));
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(new UnixBridgeClient(path).request("set_tempo"), /reinstall.*bridge/i);
  assert.deepEqual(methods, ["get_bridge_protocol"]);
});
