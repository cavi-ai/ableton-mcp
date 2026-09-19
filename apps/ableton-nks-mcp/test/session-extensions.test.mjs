import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

const sceneQuantization = (value) => ({
  value, name: ["global", "none", "8_bars", "4_bars", "2_bars", "1_bar", "1_2", "1_2_triplet", "1_4"][value],
  choices: ["global", "none", "8_bars", "4_bars", "2_bars", "1_bar", "1_2", "1_2_triplet", "1_4"]
    .map((name, index) => ({ value: index, name }))
});

test("scene launch quantization plans against the exact observed scene", async () => {
  const scenes = [{ id: "scene-0", name: "Verse", launchQuantization: sceneQuantization(0) }];
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, params) {
    calls.push({ method, params });
    if (method === "list_scenes") return { stateVersion: 4, scenes };
    if (method === "set_scene_launch_quantization") {
      return { stateVersion: 5, scene: { ...scenes[0], launchQuantization: sceneQuantization(params.value) } };
    }
    throw new Error(method);
  } } });
  const args = { sceneId: "scene-0", launchQuantization: "1_4", expectedStateVersion: 4 };
  const dry = await service.call("set_scene_launch_quantization", args);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.before, scenes[0]);
  assert.equal(dry.plan.value, 8);
  await assert.rejects(() => service.call("set_scene_launch_quantization", { ...args, sceneId: "scene-9" }), /unknown scene/);
  await assert.rejects(() => service.call("set_scene_launch_quantization", { ...args, launchQuantization: "global" }), /already selected/);
  const result = await service.call("set_scene_launch_quantization", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.scene.launchQuantization.value, 8);
  assert.equal(calls.at(-1).method, "set_scene_launch_quantization");
});

test("groove creation plans against the full musical context", async () => {
  const context = { stateVersion: 4, groove: { amount: 1, swingAmount: 0, pool: [{ id: "groove-0", name: "Swing" }] } };
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, params) {
    calls.push({ method, params });
    if (method === "get_song_musical_context") return context;
    if (method === "create_groove") {
      return { ...context, stateVersion: 5, groove: { ...context.groove,
        pool: [...context.groove.pool, { id: "groove-1", name: params.name ?? "New Groove" }] } };
    }
    throw new Error(method);
  } } });
  const dry = await service.call("create_groove", { name: "Bass Swing", expectedStateVersion: 4 });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.before, context);
  await assert.rejects(() => service.call("create_groove", { name: "   ", expectedStateVersion: 4 }), /non-empty string/);
  const unnamed = await service.call("create_groove", { expectedStateVersion: 4 });
  assert.equal(unnamed.plan.name, undefined);
  const result = await service.call("create_groove", { name: "Bass Swing", expectedStateVersion: 4, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.groove.pool[1].name, "Bass Swing");
  assert.equal(calls.at(-1).method, "create_groove");
});

test("track MIDI routing reads pass through and report unsupported maps", async () => {
  const service = new ToolService({ bridge: { async request(method, params) {
    assert.equal(method, "get_track_midi_routing");
    return { stateVersion: 4, trackId: params.trackId, midiRouting: {
      supported: false, inNote: null, outNote: null, inScale: null, outScale: null
    } };
  } } });
  const observed = await service.call("get_track_midi_routing", { trackId: "track-0" });
  assert.equal(observed.midiRouting.supported, false);
});

test("track MIDI routing mutations guard the observed map and validate bounds", async () => {
  const midiRouting = { supported: true, inNote: 0, outNote: 0, inScale: false, outScale: false };
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, params) {
    calls.push({ method, params });
    if (method === "get_track_midi_routing") return { stateVersion: 4, trackId: params.trackId, midiRouting };
    if (method === "set_track_midi_routing") {
      return { stateVersion: 5, trackId: params.trackId,
        midiRouting: { ...midiRouting, ...params.changes } };
    }
    throw new Error(method);
  } } });
  const args = { trackId: "track-0", inNote: 36, outScale: true, expectedStateVersion: 4 };
  const dry = await service.call("set_track_midi_routing", args);
  assert.deepEqual(dry.plan.before, midiRouting);
  assert.deepEqual(dry.plan.changes, { inNote: 36, outScale: true });
  await assert.rejects(() => service.call("set_track_midi_routing", { trackId: "track-0", inNote: 128, expectedStateVersion: 4 }), /from 0 to 127/);
  await assert.rejects(() => service.call("set_track_midi_routing", { trackId: "track-0", inScale: "yes", expectedStateVersion: 4 }), /boolean/);
  await assert.rejects(() => service.call("set_track_midi_routing", { trackId: "track-0", expectedStateVersion: 4 }), /at least one/);
  const result = await service.call("set_track_midi_routing", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.midiRouting.inNote, 36);
  assert.equal(calls.at(-1).method, "set_track_midi_routing");
});

test("track MIDI routing refuses to plan when Live does not expose the map", async () => {
  const service = new ToolService({ bridge: { async request(method) {
    if (method === "get_track_midi_routing") return { stateVersion: 4, trackId: "track-0", midiRouting: {
      supported: false, inNote: null, outNote: null, inScale: null, outScale: null
    } };
    throw new Error(method);
  } } });
  await assert.rejects(() => service.call("set_track_midi_routing", { trackId: "track-0", inNote: 36, expectedStateVersion: 4 }), /not exposed/);
});

test("track freeze plans with content risk and guards the observed state", async () => {
  const freeze = { supported: true, frozen: false };
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, params) {
    calls.push({ method, params });
    if (method === "get_track_freeze_state") return { stateVersion: 4, trackId: params.trackId, freeze };
    if (method === "set_track_freeze_state") return { stateVersion: 5, trackId: params.trackId,
      freeze: { ...freeze, frozen: params.frozen } };
    throw new Error(method);
  } } });
  const args = { trackId: "track-0", frozen: true, expectedStateVersion: 4 };
  const dry = await service.call("set_track_freeze_state", args);
  assert.deepEqual(dry.plan.before, freeze);
  assert.equal(dry.plan.contentMutationRisk.kind, "rendered_track_audio");
  assert.match(dry.plan.contentMutationRisk.kind, /rendered_track_audio/);
  await assert.rejects(() => service.call("set_track_freeze_state", { trackId: "track-0", frozen: false, expectedStateVersion: 4 }), /already in the requested freeze state/);
  const result = await service.call("set_track_freeze_state", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.freeze.frozen, true);
  assert.equal(calls.at(-1).method, "set_track_freeze_state");
});

test("track freeze refuses to plan when Live does not expose the state", async () => {
  const service = new ToolService({ bridge: { async request(method) {
    if (method === "get_track_freeze_state") return { stateVersion: 4, trackId: "track-0",
      freeze: { supported: false, frozen: null } };
    throw new Error(method);
  } } });
  await assert.rejects(() => service.call("set_track_freeze_state", { trackId: "track-0", frozen: true, expectedStateVersion: 4 }), /not exposed/);
});

test("arrangement MIDI clip reads and note edits resolve timeline identity", async () => {
  const arrangementClip = {
    id: "track-0:arrangement-clip-0", name: "Hook", startBeats: 8, endBeats: 16, lengthBeats: 8, type: "midi"
  };
  const extended = { stateVersion: 4, trackId: "track-0", clipId: arrangementClip.id,
    location: "arrangement", timeline: arrangementClip, lengthBeats: 8,
    notes: [{ noteId: 7, pitch: 60, start: 0, duration: 1, velocity: 100,
      velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }] };
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, params) {
    calls.push({ method, params });
    if (method === "get_midi_clip_notes_extended") return extended;
    if (method === "set_midi_note_properties") return { ...extended, stateVersion: 5,
      notes: extended.notes.map(note => note.noteId === params.changes[0].noteId
        ? { ...note, ...params.changes[0] } : note) };
    throw new Error(method);
  } } });
  const observed = await service.call("get_midi_clip_notes_extended", { trackId: "track-0", clipId: arrangementClip.id });
  assert.equal(observed.location, "arrangement");
  assert.equal(observed.timeline.startBeats, 8);
  const args = { trackId: "track-0", clipId: arrangementClip.id,
    changes: [{ noteId: 7, velocity: 42 }], expectedStateVersion: 4 };
  const dry = await service.call("set_midi_note_properties", args);
  assert.equal(dry.plan.changes[0].velocity, 42);
  const result = await service.call("set_midi_note_properties", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.notes[0].velocity, 42);
  assert.equal(result.observed.timeline.startBeats, 8);
  assert.equal(calls.at(-1).method, "set_midi_note_properties");
});
