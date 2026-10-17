import test from "node:test";
import assert from "node:assert/strict";
import {ToolService} from "../src/tool-service.mjs";
import {createRouter} from "../src/server.mjs";
import {getProducerWorkflow} from "../src/prompts.mjs";
import {validateToolArguments} from "../src/tool-validation.mjs";

test("feel contracts accept explicit origins and exact source selection, refusing malformed selection before Live", async () => {
  const args = {trackId: "track-0", clipId: "track-0:clip-0", grid: "straight16", originBeats: 1, noteIds: [7]};
  validateToolArguments("analyze_midi_feel", args);
  validateToolArguments("save_midi_feel_template", {...args, name: "selected-hats"});
  let calls = 0;
  const route = createRouter(new ToolService({bridge: {request: async () => {calls++; throw Error("unexpected native call");}}}));
  for (const invalid of [{noteIds: []}, {noteIds: [7, 7]}, {originBeats: -1}]) {
    const result = await route({id: 1, method: "tools/call", params: {name: "analyze_midi_feel", arguments: {...args, ...invalid}}});
    assert.equal(result.error.code, -32602);
  }
  assert.equal(calls, 0);
});

test("guarded feel transfer binds the target origin, edits a late loop note and preserves unrelated metadata", async () => {
  let observed = {stateVersion: 4, trackId: "track-1", clipId: "track-1:clip-0", lengthBeats: 4,
    notes: [{noteId: 7, pitch: 42, start: 5.25, duration: .1, velocity: 50, probability: .7, velocityDeviation: 8, releaseVelocity: 64, mute: false},
      {noteId: 8, pitch: 36, start: .5, duration: .2, velocity: 80, probability: 1, velocityDeviation: 0, releaseVelocity: 64, mute: true}]};
  const before = structuredClone(observed), timing = {stateVersion: 4, trackId: observed.trackId, clipId: observed.clipId,
    timeSignature: {numerator: 4, denominator: 4}, grooveId: null, loop: {startBeats: 2, endBeats: 6},
    markers: {supported: true, unit: "beats", startBeats: 2, endBeats: 6}};
  let writes = 0;
  const service = new ToolService({bridge: {request: async (method, plan) => {
    if (method === "get_midi_clip_notes_extended") return structuredClone(observed);
    if (method === "get_clip_timing") return structuredClone(timing);
    assert.equal(method, "set_midi_note_properties");
    assert.deepEqual(plan.before, before);
    assert.deepEqual(plan.clipTiming, timing);
    assert.equal(plan.originBeats, 2);
    writes++;
    observed.notes = observed.notes.map(note => {const change = plan.changes.find(c => c.noteId === note.noteId); if (!change) return note;
      const {previous, ...values} = change; return {...note, ...values};});
    observed.stateVersion++;
    return structuredClone(observed);
  }}});
  const template = {format: "cavi-midi-feel-v1", grid: "straight16", bars: 1, barBeats: 4, nativeGrooveId: null,
    source: {trackId: "track-0", clipId: "track-0:clip-0", stateVersion: 4, originBeats: 1, noteIds: [1]},
    slots: [{slot: 13, hitCount: 1, meanOffsetBeats: .05, meanVelocity: 90}]};
  const args = {trackId: observed.trackId, clipId: observed.clipId, expectedStateVersion: 4,
    template, originBeats: 2, noteIds: [7], timingAmount: 1, velocityAmount: .5};
  validateToolArguments("apply_midi_feel_template", args);
  const dry = await service.call("apply_midi_feel_template", args);
  assert.equal(writes, 0);
  assert.ok(Math.abs(dry.plan.changes[0].start - 5.3) < 1e-9);
  await assert.rejects(service.call("apply_midi_feel_template", {...args, originBeats: 6, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash}), /confirmation|plan/i);
  assert.equal(writes, 0);
  const fresh = await service.call("apply_midi_feel_template", args);
  const result = await service.call("apply_midi_feel_template", {...args, dryRun: false,
    confirmationToken: fresh.confirmation.token, planHash: fresh.confirmation.planHash});
  assert.equal(writes, 1);
  assert.deepEqual(result.observed.notes[1], before.notes[1]);
  assert.deepEqual({...result.observed.notes[0], start: before.notes[0].start, velocity: before.notes[0].velocity}, before.notes[0]);
});

test("MIDI feel workflow is available through producer discovery without calling Live", async () => {
  const route = createRouter(new ToolService({bridge: {request: async () => {throw Error("unexpected native call");}}}), {toolProfile: "producer"});
  const listed = await route({id: 1, method: "tools/call", params: {name: "get_producer_workflow", arguments: {}}});
  assert.ok(listed.result.structuredContent.workflows.find(w => w.name === "match-midi-feel"));
  assert.throws(() => getProducerWorkflow({workflow: "match-midi-feel"}), /request/);
  assert.throws(() => getProducerWorkflow({workflow: "match-midi-feel", arguments: {request: "Follow the hats", mode: "replace"}}), /mode/);
  const text = getProducerWorkflow({workflow: "match-midi-feel", arguments: {request: "Give the bass the hat timing", mode: "autonomous"}}).messages[0].content.text;
  assert.match(text, /Give the bass the hat timing/);
  assert.match(text, /originBeats/);
  assert.match(text, /noteIds/);
  assert.match(text, /duplicate_clip/);
  assert.match(text, /fresh copy.*original|original.*fresh copy/i);
  assert.match(text, /native groove/);
  assert.match(text, /manual edits/);
});
