import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {MacClipGrooveHost} from "../src/clip-groove-removal.mjs";
import {getProducerWorkflow} from "../src/prompts.mjs";

function fixture({changedDuringMenu = false, changedAfter = false, unchangedAfter = false, wrongSelection = false} = {}) {
  const clip = {stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", trackName: "Bass", clipName: "Unique bass clip",
    source: {type: "midi", content: {stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", lengthBeats: 4,
      notes: [{noteId: 1, pitch: 60, start: .27, duration: .1, velocity: 81, velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false}]}},
    timing: {stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", grooveId: "groove-0", loop: {startBeats: 0, endBeats: 4}, availableGrooves: [{id: "groove-0", name: "Swing"}]},
    musicalContext: {stateVersion: 4, groove: {amount: 1, pool: [{id: "groove-0", name: "Swing"}]}}};
  const context = {stateVersion: 4, setFingerprint: "set", filePath: "/sets/Idea.als", clip};
  const original = structuredClone(context), calls = []; let preparations = 0, clicks = 0;
  const host = {context: async () => ({pid: 42, filePath: context.filePath}), remove: async (_, {prepared, recheck}) => {
    await prepared();
    if (changedDuringMenu) context.clip.source.content.notes[0].velocity++;
    await recheck(); clicks++;
    if (!unchangedAfter) context.clip.timing.grooveId = null;
    if (changedAfter) context.clip.source.content.notes[0].start += .1;
    return {noneSelected: true};
  }};
  const service = new ToolService({grooveRemovalHost: host, bridge: {request: async (method, params) => {
    calls.push(method);
    if (method === "get_clip_groove_removal_context") return structuredClone(context);
    if (method === "prepare_clip_groove_removal") {
      assert.deepEqual(params.before, original); preparations++; context.stateVersion++;
      return {stateVersion: 5, trackId: clip.trackId, clipId: clip.clipId, prepared: true};
    }
    if (method === "get_selection_context") return {setFingerprint: "set", detailClip: {trackId: clip.trackId, clipId: wrongSelection ? "track-0:clip-1" : clip.clipId}};
    if (method === "get_clip_groove_context") return structuredClone(context.clip);
    throw Error(method);
  }}});
  const args = {trackId: clip.trackId, clipId: clip.clipId, expectedStateVersion: 4, grooveId: null};
  return {service, args, calls, context, counts: () => ({preparations, clicks})};
}

async function apply(f) {
  const dry = await f.service.call("set_clip_timing", f.args);
  assert.equal(dry.plan.method, "remove_clip_groove");
  assert.deepEqual(f.counts(), {preparations: 0, clicks: 0});
  return f.service.call("set_clip_timing", {...f.args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash});
}

test("explicit null removal uses guarded UI and verifies only assignment changed", async () => {
  const f = fixture(), result = await apply(f);
  assert.equal(result.removalVerified, true);
  assert.equal(result.observed.grooveId, null);
  assert.equal(result.verification.sourceContentChanged, false);
  assert.deepEqual(result.focus, {trackId: f.args.trackId, clipId: f.args.clipId, view: "Detail/Clip"});
  assert.deepEqual(f.counts(), {preparations: 1, clicks: 1});
  assert.equal(f.calls.includes("set_clip_timing"), false);
});

test("groove removal refuses combined edits and stale confirmation before UI preparation", async () => {
  const f = fixture();
  await assert.rejects(f.service.call("set_clip_timing", {...f.args, mute: false}), /only clip timing change/);
  assert.deepEqual(f.calls, []);
  const dry = await f.service.call("set_clip_timing", f.args);
  f.context.clip.source.content.notes[0].velocity++;
  await assert.rejects(f.service.call("set_clip_timing", {...f.args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash}), /plan hash mismatch/);
  assert.deepEqual(f.counts(), {preparations: 0, clicks: 0});
});

test("changed content or selection before None prevents clicking; changed or uncleared readback cannot verify", async () => {
  for (const options of [{changedDuringMenu: true}, {wrongSelection: true}]) {
    const f = fixture(options); await assert.rejects(apply(f), /changed|unverified/); assert.equal(f.counts().clicks, 0);
  }
  await assert.rejects(apply(fixture({changedAfter: true})), /source content changed/);
  await assert.rejects(apply(fixture({unchangedAfter: true})), /assignment postcondition/);
});

test("nullable groove contract is exposed by MCP and invalid types stop before Live", async () => {
  const f = fixture(), route = createRouter(f.service);
  const response = await route({id: 1, method: "tools/call", params: {name: "set_clip_timing", arguments: f.args}});
  assert.equal(response.result.structuredContent.plan.method, "remove_clip_groove");
  const count = f.calls.length;
  const invalid = await route({id: 2, method: "tools/call", params: {name: "set_clip_timing", arguments: {...f.args, grooveId: 0}}});
  assert.equal(invalid.error.code, -32602); assert.equal(f.calls.length, count);
});

test("groove UI host rechecks between menu preparation and selection and cancels only before commit", async () => {
  for (const stale of [false, true]) {
    const order = [], actions = [];
    const host = new MacClipGrooveHost({platform: "darwin", run: async (command, args, options) => {
      if (command === "/usr/bin/open") {order.push("focus"); return {stdout: ""};}
      const input = JSON.parse(args.at(-1)); order.push(input.action); actions.push(input.action);
      if (input.action === "cancel") assert.equal(options.signal.aborted, false);
      return {stdout: JSON.stringify(input.action === "prepare" ? {prepared: true, menuTitles: ["None", "Swing"]} : {noneSelected: input.action === "commit", cancelled: input.action === "cancel"})};
    }});
    const execute = () => host.remove({pid: 42, appPath: "/Live.app"}, {
      prepared: async () => order.push("native preparation"),
      recheck: async () => {order.push("native recheck"); if (stale) throw Error("clip changed");}
    });
    if (stale) {await assert.rejects(execute(), /clip changed/); assert.deepEqual(actions, ["prepare", "cancel"]);}
    else {assert.equal((await execute()).noneSelected, true); assert.deepEqual(actions, ["prepare", "commit"]);}
    assert.deepEqual(order, ["native preparation", "focus", "prepare", "native recheck", stale ? "cancel" : "commit"]);
    assert.equal(host.busy, false);
  }
});

test("native groove workflow is discoverable without Live and validates intent and mode", async () => {
  const service = new ToolService({bridge: {request: async () => {throw Error("unexpected Live call");}}});
  const route = createRouter(service, {toolProfile: "producer"});
  const listed = await route({id: 1, method: "tools/call", params: {name: "get_producer_workflow", arguments: {}}});
  assert.ok(listed.result.structuredContent.workflows.find(w => w.name === "try-clip-groove"));
  assert.throws(() => getProducerWorkflow({workflow: "try-clip-groove"}), /request/);
  assert.throws(() => getProducerWorkflow({workflow: "try-clip-groove", arguments: {request: "Try swing", mode: "replace"}}), /mode/);
  const text = getProducerWorkflow({workflow: "try-clip-groove", arguments: {request: "Try a swing alternative", mode: "autonomous"}}).messages[0].content.text;
  assert.match(text, /Try a swing alternative/);
  assert.match(text, /duplicate_clip/);
  assert.match(text, /duplicate_arrangement_clip.*nonoverlapping startBeats/);
  assert.doesNotMatch(text, /retrieve arrange-session-ideas/);
  assert.match(text, /grooveId: null/);
  assert.match(text, /unique clip name/);
  assert.match(text, /global.*other clips|other clips.*global/i);
  assert.match(text, /not.*bak|without baking/i);
  assert.match(text, /manual edits/);
});
