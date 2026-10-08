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
      for (const request of decoded.messages) receive(socket, request);
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
