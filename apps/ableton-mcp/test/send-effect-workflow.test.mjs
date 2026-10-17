import test from "node:test";
import assert from "node:assert/strict";
import {createRouter} from "../src/server.mjs";
import {ToolService} from "../src/tool-service.mjs";
import {getProducerWorkflow} from "../src/prompts.mjs";

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

test("shared send-effect guidance is discoverable without opening Live", async () => {
  let calls = 0;
  const service = new ToolService({bridge: {request: async () => {calls++; throw Error("must not observe Live");}}});
  const route = createRouter(service, {toolProfile: "producer"});
  const listing = await route({id: 1, method: "tools/call", params: {name: "get_producer_workflow", arguments: {}}});
  const descriptor = listing.result.structuredContent.workflows.find(w => w.name === "add-send-effect");
  assert.ok(descriptor);
  assert.equal(descriptor.arguments.find(a => a.name === "request").required, true);
  const rendered = await route({id: 2, method: "tools/call", params: {name: "get_producer_workflow", arguments: {
    workflow: "add-send-effect", arguments: {request: "Share a room reverb between the chords and bass"}
  }}});
  assert.equal(rendered.result.structuredContent.workflow, "add-send-effect");
  assert.match(rendered.result.structuredContent.messages[0].content.text, /Share a room reverb between the chords and bass/);
  assert.equal(calls, 0);
});

test("send-effect mode validates intent and chooses only within the requested scope", () => {
  assert.throws(() => getProducerWorkflow({workflow: "add-send-effect"}), /request/);
  assert.throws(() => getProducerWorkflow({workflow: "add-send-effect", arguments: {request: "Add delay", mode: "replace"}}), /mode/);
  const text = getProducerWorkflow({workflow: "add-send-effect", arguments: {request: "Add delay", mode: "autonomous"}}).messages[0].content.text;
  assert.match(text, /Choose.*within the brief/);
  assert.match(text, /create_return_track/);
  assert.match(text, /get_factory_browser_items/);
  assert.match(text, /set_track_send_db/);
  assert.match(text, /sendId.*returnTrackId/);
  assert.match(text, /native dB/);
});

test("parallel effect guidance preserves dry paths, existing shared processing and manual edits", () => {
  const text = getProducerWorkflow({workflow: "add-send-effect", arguments: {request: "Add a little room"}}).messages[0].content.text;
  assert.match(text, /Do not use route_tracks_to_return_bus/);
  assert.match(text, /Sends Only/);
  assert.match(text, /existing Return.*other parts/);
  assert.match(text, /100% wet.*new/);
  assert.match(text, /source.*routing.*preserv/i);
  assert.match(text, /pre\/post.*not exposed/);
  assert.match(text, /partial.*inspect|inspect.*partial/i);
  assert.match(text, /manual edits/);
  assert.match(text, /what the user hears/);
  assert.match(text, /not.*audible|does not.*audible/i);
});
