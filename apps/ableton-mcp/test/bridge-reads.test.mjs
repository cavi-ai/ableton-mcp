import test from "node:test";
import assert from "node:assert/strict";
import { bridgeReadNames, readBridgeContext } from "../src/bridge-reads.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";

test("the bridge read registry contains contracted read-only operations only", async () => {
  assert.ok(bridgeReadNames.length > 10);
  for (const name of bridgeReadNames) {
    assert.equal(toolContracts[name].annotations.readOnlyHint, true, name);
    let request;
    const value = await readBridgeContext({ request: async (method, args) => { request = { method, args }; return { name }; } }, name, {});
    assert.equal(request.method, name); assert.deepEqual(value, { name });
  }
});

test("bridge reads preserve exact target arguments and reject unregistered dispatch", async () => {
  const calls = [], bridge = { request: async (method, args) => { calls.push({ method, args }); return {}; } };
  const args = { trackId: "track-0", deviceId: "track-0:device-0" };
  await readBridgeContext(bridge, "list_device_parameters", args);
  assert.equal(calls[0].args, args);
  await readBridgeContext(bridge, "get_live_state", args);
  assert.deepEqual(calls[1].args, {});
  for (const name of ["set_tempo", "constructor", "__proto__"]) assert.throws(() => readBridgeContext(bridge, name, {}), /unknown bridge read/);
  assert.equal(calls.length, 2);
});
