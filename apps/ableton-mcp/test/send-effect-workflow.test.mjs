import test from "node:test";
import assert from "node:assert/strict";
import {createRouter} from "../src/server.mjs";
import {ToolService} from "../src/tool-service.mjs";

test("Return routing reads exact destinations through the all profile without writing", async () => {
  const calls = [], observed = {stateVersion: 8, returnTrackId: "return-1", output: {type: {id: "external", name: "Ext. Out"}}};
  const service = new ToolService({bridge: {request: async (method, args) => {calls.push({method, args}); return observed;}}});
  const route = createRouter(service);
  const result = await route({id: 1, method: "tools/call", params: {name: "get_return_routing", arguments: {returnTrackId: "return-1"}}});
  assert.deepEqual(result.result?.structuredContent, observed);
  assert.deepEqual(calls, [{method: "get_return_routing", args: {returnTrackId: "return-1"}}]);
  for (const args of [{}, {returnTrackId: "return-1", outputTypeId: "main"}]) assert.equal((await route({id: 2, method: "tools/call", params: {name: "get_return_routing", arguments: args}})).error?.code, -32602);
  assert.equal(calls.length, 1);
  const core = createRouter(service, {toolProfile: "core"});
  assert.equal((await core({id: 3, method: "tools/call", params: {name: "get_return_routing", arguments: {returnTrackId: "return-1"}}})).error.code, -32601);
});
