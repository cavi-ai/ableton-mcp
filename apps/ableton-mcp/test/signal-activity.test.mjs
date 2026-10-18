import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {toolContracts} from "../src/tool-contracts.mjs";
import {getProducerWorkflow} from "../src/prompts.mjs";

test("signal activity is an exact read-only bridge request in the all profile", async () => {
  const calls = [], observed = {stateVersion: 4, trackId: "return-0", meters: {output: {status: "available", value: .25}},
    groupContext:{status:"not_applicable",parents:[],reason:null},
    soloContext:{status:"partial",soloedTracks:[{trackId:"track-1",name:"Drums",solo:true}],unknownTrackIds:["return-0"]}};
  const service = new ToolService({bridge: {request: async (method, args) => {
    calls.push({method, args}); return observed;
  }}}), route = createRouter(service);
  const result = await route({id: 1, method: "tools/call", params: {name: "get_track_signal_activity", arguments: {trackId: "return-0"}}});
  assert.deepEqual(result.result?.structuredContent, observed);
  assert.deepEqual(calls, [{method: "get_track_signal_activity", args: {trackId: "return-0"}}]);
  assert.equal(toolContracts.get_track_signal_activity.annotations.readOnlyHint, true);
  assert.equal(toolContracts.get_track_signal_activity.annotations.destructiveHint, false);
  const core = createRouter(service, {toolProfile: "core"});
  assert.equal((await core({id: 2, method: "tools/call", params: {name: "get_track_signal_activity", arguments: {trackId: "master"}}})).error.code, -32601);
});

test("signal snapshot rejects missing targets and mutation or sampling options before native access", async () => {
  let calls = 0;
  const service = new ToolService({bridge: {request: async () => {calls++;}}}), route = createRouter(service);
  for (const args of [{}, {trackId: "master", dryRun: false}, {trackId: "track-0", durationSeconds: 10}]) {
    assert.equal((await route({id: 1, method: "tools/call", params: {name: "get_track_signal_activity", arguments: args}})).error?.code, -32602);
  }
  assert.equal(calls, 0);
});

test("batch signal activity uses one read and preserves the native ordered response", async () => {
  const calls = [], observed = {stateVersion: 4, transport: {isPlaying: true}, tracks: [
    {trackId: "track-0"}, {trackId: "return-0"}, {trackId: "master"}
  ]};
  const service = new ToolService({bridge: {request: async (method, args) => {
    calls.push({method, args}); return observed;
  }}}), route = createRouter(service);
  const args = {trackIds: ["track-0", "return-0", "master"]};
  const result = await route({id: 1, method: "tools/call", params: {name: "get_track_signal_activity", arguments: args}});
  assert.deepEqual(result.result?.structuredContent, observed);
  assert.deepEqual(calls, [{method: "get_track_signal_activity", args}]);
});

test("batch signal scope is exclusive bounded and unique before native access", async () => {
  let calls = 0;
  const route = createRouter(new ToolService({bridge: {request: async () => {calls++;}}}));
  for (const args of [{trackIds: []}, {trackIds: ["master", "master"]}, {trackIds: [1]},
    {trackIds: "master"}, {trackIds: Array.from({length: 65}, (_, n) => `track-${n}`)},
    {trackId: "master", trackIds: ["track-0"]}, {trackIds: ["master"], durationSeconds: 1}]) {
    assert.equal((await route({id: 1, method: "tools/call", params: {name: "get_track_signal_activity", arguments: args}})).error?.code, -32602);
  }
  assert.equal(calls, 0);
});

test("silent-part workflow resolves actual signal evidence and preserves the performance", () => {
  assert.throws(() => getProducerWorkflow({workflow: "diagnose-silent-part"}), /request/);
  const workflow = getProducerWorkflow({workflow: "diagnose-silent-part", arguments: {request: "Why is the bass silent?"}});
  const text = workflow.messages[0].content.text;
  assert.match(text, /Why is the bass silent\?/);
  for (const term of ["get_track_signal_activity", "get_track_routing", "get_track_mixer", "get_set_mixer", "list_devices", "get_transport_recording_context", "get_device_hierarchy"]) assert.ok(text.includes(term), term);
  assert.match(text, /one.second/i);
  assert.match(text, /zero.*silence/i);
  assert.match(text, /unavailable.*unknown/i);
  assert.match(text, /MIDI.*audio/i);
  assert.match(text, /speaker/i);
  assert.match(text, /Never.*unmute/i);
  assert.match(text, /fresh.*plan/i);
  for(const term of ['groupContext','soloContext','groupMembershipOnly','status','unknownTrackIds','membership','routing']) assert.ok(text.includes(term),term);
});
