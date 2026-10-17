import test from "node:test";
import assert from "node:assert/strict";
import {createRouter} from "../src/server.mjs";
import {ToolService} from "../src/tool-service.mjs";
import {getProducerWorkflow} from "../src/prompts.mjs";

test("sidechain workflow is discoverable and renders through producer tools without Live", async () => {
  let calls = 0;
  const service = new ToolService({bridge: {request: async () => {calls++; throw Error("unexpected Live call");}}});
  const route = createRouter(service, {toolProfile: "producer"});
  const listed = await route({id: 1, method: "tools/call", params: {name: "get_producer_workflow", arguments: {}}});
  assert.ok(listed.result.structuredContent.workflows.find(w => w.name === "duck-against-source"));
  const rendered = await route({id: 2, method: "tools/call", params: {name: "get_producer_workflow", arguments: {
    workflow: "duck-against-source", arguments: {request: "Make room for the kick on the bass"}
  }}});
  assert.equal(rendered.result.structuredContent.workflow, "duck-against-source");
  assert.match(rendered.result.structuredContent.messages[0].content.text, /Make room for the kick on the bass/);
  assert.equal(calls, 0);
});

test("sidechain workflow requires intent and validates collaborative or autonomous mode", () => {
  assert.throws(() => getProducerWorkflow({workflow: "duck-against-source"}), /request/);
  assert.throws(() => getProducerWorkflow({workflow: "duck-against-source", arguments: {request: "Duck bass", mode: "replace"}}), /mode/);
  const text = getProducerWorkflow({workflow: "duck-against-source", arguments: {request: "Duck bass from kick", mode: "autonomous"}}).messages[0].content.text;
  assert.match(text, /Choose.*within the brief/);
  assert.match(text, /set_device_sidechain_routing/);
  assert.match(text, /sourceTypeId.*sourceChannelId/);
  assert.match(text, /re-read.*channels|refreshed.*channels/i);
});

test("sidechain guidance distinguishes external enable, detector routing and audible ducking", () => {
  const text = getProducerWorkflow({workflow: "duck-against-source", arguments: {request: "Subtle kick ducking"}}).messages[0].content.text;
  assert.match(text, /S\/C.*external/i);
  assert.match(text, /unsupported/);
  assert.match(text, /track input routing/);
  assert.match(text, /Pre FX.*Post FX.*Post Mixer/);
  assert.match(text, /IDs remain ambiguous, leave routing unchanged/);
  assert.match(text, /set_device_parameter_display/);
  assert.match(text, /ratio.*not.*dB|ratio.*unsupported/i);
  assert.match(text, /partial.*inspect|inspect.*partial/i);
  assert.match(text, /manual edits/);
  assert.match(text, /gain reduction.*not.*exposed|not.*gain reduction.*exposed/i);
  assert.match(text, /what the user hears/);
});
