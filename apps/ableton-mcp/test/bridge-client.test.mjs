import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixBridgeClient } from "../src/bridge-client.mjs";
import { decodeBridgeLines, encodeBridgeMessage } from "../src/bridge-protocol.mjs";
import { runCli } from '../src/cli.mjs';
import { createRouter } from '../src/server.mjs';
import { ToolService } from '../src/tool-service.mjs';

async function listener(t, receive, { handshake = true } = {}) {
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
        if (request.method === "get_bridge_protocol" && handshake) socket.write(encodeBridgeMessage({ id: request.id,
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
  return { client: new UnixBridgeClient(path, { timeoutMs: 1000 }), path, directory, connections: () => connections };
}

test('transport failures identify connection progress without claiming a request was transmitted', async t => {
 const root=await mkdtemp(join(tmpdir(),'ab-connect-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const client=new UnixBridgeClient(join(root,'missing.sock'));
 await assert.rejects(client.request('get_live_state'),error=>{
  assert.equal(error.outcome,'not_executed');
  assert.equal(error.bridgeProgress.phase,'connect');
  assert.equal(error.bridgeProgress.socketConnected,false);
  assert.equal(error.bridgeProgress.protocolValidated,false);
  assert.equal(error.bridgeProgress.requestTransmitted,false);
  assert.equal(error.bridgeProgress.repliesReceived,0);
  assert.ok(Number.isFinite(error.bridgeProgress.elapsedMs)&&error.bridgeProgress.elapsedMs>=0);
  return true;
 });
});

test('a stalled handshake is distinguished from a transmitted request with partial replies', async t => {
 const waiting=await listener(t,()=>{},{handshake:false});waiting.client.timeoutMs=200;
 await assert.rejects(waiting.client.request('get_live_state'),error=>{
  assert.equal(error.code,'BRIDGE_TIMEOUT');assert.equal(error.outcome,'not_executed');
  assert.equal(error.bridgeProgress.phase,'handshake');assert.equal(error.bridgeProgress.socketConnected,true);
  assert.equal(error.bridgeProgress.protocolValidated,false);assert.equal(error.bridgeProgress.requestTransmitted,false);
  return true;
 });
 const partial=await listener(t,(socket,r)=>{
  if(r.method==='first')socket.write(encodeBridgeMessage({id:r.id,result:{}}));
 });partial.client.timeoutMs=200;
 await assert.rejects(partial.client.requestMany([{method:'first'},{method:'second'}]),error=>{
  assert.equal(error.outcome,'unknown');assert.equal(error.bridgeProgress.phase,'response');
  assert.equal(error.bridgeProgress.protocolValidated,true);assert.equal(error.bridgeProgress.requestTransmitted,true);
  assert.equal(error.bridgeProgress.requestCount,2);assert.equal(error.bridgeProgress.repliesReceived,1);
  return true;
 });
});

test('doctor reports a connected compatible bridge separately from an unavailable Live state', async t => {
 const f=await listener(t,(socket,r)=>{
  if(r.id)socket.write(encodeBridgeMessage({id:r.id,error:{code:'BRIDGE_BUSY',message:'request queue full',outcome:'not_executed'}}));
 });
 const result=await runCli(['doctor','--json'],{env:{ABLETON_MCP_BRIDGE_SOCKET:f.path},home:f.directory,
  applicationsRoot:f.directory,stdout:()=>{}});
 assert.equal(result.ok,false);assert.equal(result.bridge.connected,true);
 assert.equal(result.bridge.protocol,'compatible');assert.equal(result.bridge.liveStateAvailable,false);
 assert.equal(result.bridge.capabilities,null);assert.equal(result.bridge.missingCapabilities,null);
 assert.equal(result.bridge.failure.code,'BRIDGE_BUSY');assert.equal(result.bridge.failure.outcome,'not_executed');
 assert.equal(result.bridge.failure.bridgeProgress.phase,'response');
 assert.ok(Number.isFinite(result.bridge.probeElapsedMs));
});

test('doctor distinguishes incompatible protocol and retains the refusal before transmission', async t => {
 const f=await listener(t,(socket,r)=>socket.write(encodeBridgeMessage({id:r.id,result:{version:1}})),{handshake:false});
 const result=await runCli(['doctor','--json'],{env:{ABLETON_MCP_BRIDGE_SOCKET:f.path},home:f.directory,
  applicationsRoot:f.directory,stdout:()=>{}});
 assert.equal(result.ok,false);assert.equal(result.bridge.connected,true);assert.equal(result.bridge.protocol,'incompatible');
 assert.equal(result.bridge.liveStateAvailable,false);assert.equal(result.bridge.failure.outcome,'not_executed');
 assert.equal(result.bridge.failure.bridgeProgress.requestTransmitted,false);
});

test('MCP errors preserve progress and uncertain outcomes without claiming a retry is safe', async t => {
 const f=await listener(t,(socket,r)=>socket.write(encodeBridgeMessage({id:r.id,error:{message:'native failure'}})));
 const route=createRouter({call:()=>f.client.request('get_live_state')});
 const response=await route({id:1,method:'tools/call',params:{name:'get_live_state',arguments:{}}});
 assert.equal(response.result.isError,true);const error=response.result.structuredContent.error;
 assert.equal(error.outcome,'unknown');assert.equal(error.bridgeProgress.protocolValidated,true);
 assert.equal(error.bridgeProgress.requestTransmitted,true);assert.equal(error.bridgeProgress.repliesReceived,1);
 assert.equal(error.requestIds.length,1);assert.match(error.message,/re-read/);
});

test('doctor allows a Live read longer than its former one-second deadline', async t => {
 const f=await listener(t,(socket,r)=>{
  if(r.method==='get_live_state')setTimeout(()=>socket.write(encodeBridgeMessage({id:r.id,
    result:{bridgeVersion:'0.2.1',capabilities:[]}})),1200);
 });
 const result=await runCli(['doctor','--json'],{env:{ABLETON_MCP_BRIDGE_SOCKET:f.path},home:f.directory,
  applicationsRoot:f.directory,stdout:()=>{}});
 assert.equal(result.bridge.connected,true);assert.equal(result.bridge.protocol,'compatible');
 assert.equal(result.bridge.liveStateAvailable,true);
 assert.equal(result.ok,false); // An observed response still lacks required advertised capabilities.
 assert.ok(Array.isArray(result.bridge.missingCapabilities));
});

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

for (const nested of [false, true]) test(`factory context uses one bridge connection for ${nested ? "nested" : "top-level"} devices`, async t => {
  const args = { trackId: "track-0", deviceId: nested ? "track-0:device-0/chain-0/device-0" : "track-0:device-0" };
  const device = { id: args.deviceId, name: "EQ Eight", className: "Eq8", type: "audio_effect" };
  const { client, connections } = await listener(t, (socket, request) => {
    if (request.method !== "list_device_parameters")
      assert.equal(request.method, nested ? "get_device_hierarchy" : "list_devices");
    assert.deepEqual(request.params, nested || request.method === "list_device_parameters" ? args : { trackId: args.trackId });
    const result = request.method === "list_device_parameters"
      ? { stateVersion: 7, ...args, parameters: [{ id: "frequency", name: "1 Frequency A", value: 800 }] }
      : { stateVersion: 7, trackId: args.trackId, ...(nested ? { device } : { devices: [device] }) };
    socket.write(encodeBridgeMessage({ id: request.id, result }));
  });
  const context = await new ToolService({ bridge: client }).call("get_factory_device_context", args);
  assert.equal(context.device.id, args.deviceId);
  assert.equal(context.profile.id, "eq-eight");
  assert.equal(context.parameterCoverage.total, 1);
  assert.equal(connections(), 1);
});

test("factory context refuses changed versions without retrying the batch", async t => {
  const args = { trackId: "track-0", deviceId: "track-0:device-0" };
  const { client, connections } = await listener(t, (socket, request) => {
    const result = request.method === "list_device_parameters"
      ? { stateVersion: 8, ...args, parameters: [] }
      : { stateVersion: 7, trackId: args.trackId, devices: [{ id: args.deviceId, className: "Eq8" }] };
    socket.write(encodeBridgeMessage({ id: request.id, result }));
  });
  await assert.rejects(new ToolService({ bridge: client }).call("get_factory_device_context", args), /device context changed/);
  assert.equal(connections(), 1);
});

test("factory context propagates failed parameter reads without retrying", async t => {
  const args = { trackId: "track-0", deviceId: "track-0:device-0" };
  const { client, connections } = await listener(t, (socket, request) => socket.write(encodeBridgeMessage(
    request.method === "list_device_parameters"
      ? { id: request.id, error: { message: "parameter read failed" } }
      : { id: request.id, result: { stateVersion: 7, devices: [{ id: args.deviceId, className: "Eq8" }] } }
  )));
  await assert.rejects(new ToolService({ bridge: client }).call("get_factory_device_context", args), /parameter read failed/);
  assert.equal(connections(), 1);
});

test("factory context refuses incomplete batch results without individual fallback reads", async () => {
  for (const results of [[], [{}], [null, {}], [{}, null]]) {
    const bridge = { requestMany: async () => results,
      request: async () => { throw new Error("unexpected individual read"); } };
    await assert.rejects(new ToolService({ bridge }).call("get_factory_device_context", {
      trackId: "track-0", deviceId: "track-0:device-0"
    }), /incomplete device context batch/);
  }
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
  const request = client.request("set_tempo", { tempo: 130 });
  const createdBy = Date.now();
  await assert.rejects(request, error => {
    assert.equal(error.code, "BRIDGE_TIMEOUT");
    assert.equal(error.outcome, "unknown");
    assert.match(error.message, /read.*before.*retry/i);
    return true;
  });
  const frame = await cancelled;
  assert.deepEqual(frame.cancelRequestIds, [received[0].id]);
  assert.ok(received[0].deadlineUnixMs >= started + client.timeoutMs);
  assert.ok(received[0].deadlineUnixMs <= createdBy + client.timeoutMs);
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
