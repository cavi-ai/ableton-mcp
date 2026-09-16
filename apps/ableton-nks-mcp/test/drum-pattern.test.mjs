import test from "node:test";
import assert from "node:assert/strict";
import { planDrumPattern } from "../src/drum-pattern.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const reference = {
  stateVersion: 80,
  timeSignature: { numerator: 4, denominator: 4 },
  tempoBpm: 120,
  barLengthBeats: 4,
  grids: {
    straight16: { stepsPerQuarter: 4, stepsPerBar: 16, barBoundaryOnGrid: true },
    eighthTriplet: { stepsPerQuarter: 3, stepsPerBar: 12, barBoundaryOnGrid: true },
    sixteenthTriplet: { stepsPerQuarter: 6, stepsPerBar: 24, barBoundaryOnGrid: true }
  }
};

test("house drum lanes repeat on the selected bar grid with explicit accents", () => {
  const plan = planDrumPattern(reference, {
    grid: "straight16", bars: 1, startBeat: 0, lanes: [
      { role: "kick", note: 36, activeSteps: [1, 5, 9, 13], velocity: 110, gate: 0.5 },
      { role: "snare", note: 38, activeSteps: [5, 13], velocity: 105, gate: 0.5 },
      { role: "closed_hat", note: 42, activeSteps: [3, 7, 11, 15], velocity: 75,
        accentSteps: [3, 11], accentVelocity: 95, gate: 0.25 }
    ]
  });
  assert.equal(plan.lengthBeats, 4);
  assert.equal(plan.stepBeats, 0.25);
  assert.equal(plan.tempoBpm, 120);
  assert.equal(plan.notes.length, 10);
  assert.deepEqual(plan.notes.filter(note => note.pitch === 36).map(note => note.start), [0, 1, 2, 3]);
  assert.deepEqual(plan.notes.filter(note => note.pitch === 38).map(note => note.start), [1, 3]);
  assert.deepEqual(plan.notes.filter(note => note.pitch === 42).map(note => [note.start, note.velocity]),
    [[0.5, 95], [1.5, 75], [2.5, 95], [3.5, 75]]);
});

test("drum planning rejects ambiguous lanes and unsafe output", () => {
  const lane = { role: "kick", note: 36, activeSteps: [1], velocity: 100, gate: 0.5 };
  assert.throws(() => planDrumPattern(reference, { grid: "straight16", bars: 1,
    lanes: [lane, { ...lane, role: "layer" }] }), /unique MIDI note/);
  assert.throws(() => planDrumPattern(reference, { grid: "straight16", bars: 1,
    lanes: [{ ...lane, accentSteps: [2], accentVelocity: 120 }] }), /unique active steps/);
  assert.throws(() => planDrumPattern(reference, { grid: "straight16", bars: 1,
    lanes: [{ ...lane, accentVelocity: 120 }] }), /accentVelocity requires accentSteps/);
  assert.throws(() => planDrumPattern(reference, { grid: "straight16", bars: 16,
    lanes: Array.from({ length: 17 }, (_, index) => ({ ...lane, role: `lane-${index}`, note: index,
      activeSteps: Array.from({ length: 16 }, (_, step) => step + 1) })) }), /4096 MIDI notes/);
  assert.throws(() => planDrumPattern({ ...reference, barLengthBeats: Number.MAX_VALUE }, {
    grid: "straight16", bars: 2, lanes: [lane]
  }), /derived drum timing must be finite/);
  assert.throws(() => planDrumPattern({ ...reference, tempoBpm: 0 }, {
    grid: "straight16", bars: 1, lanes: [lane]
  }), /tempoBpm must be finite and positive/);
});

test("triplet drum planning remains locked to the current song grid", async () => {
  const context = { stateVersion: 80, timeSignature: reference.timeSignature, key: {} };
  const bridge = { async request(method) {
    if (method === "get_live_state") return { stateVersion: 80, setFingerprint: "set:drums", tempo: 120 };
    if (method === "get_song_musical_context") return context;
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const result = await service.call("plan_drum_pattern", { grid: "eighthTriplet", bars: 1,
    lanes: [
      { role: "kick", note: 36, activeSteps: [1, 7, 10], velocity: 110, gate: 0.5 },
      { role: "snare", note: 38, activeSteps: [7], velocity: 105, gate: 0.5 },
      { role: "hat", note: 42, activeSteps: Array.from({ length: 12 }, (_, index) => index + 1),
        velocity: 70, accentSteps: [1, 4, 7, 10], accentVelocity: 90, gate: 0.25 }
    ]
  });
  assert.equal(result.stateVersion, 80);
  assert.equal(result.plan.stepBeats, 1 / 3);
  assert.deepEqual(result.plan.notes.filter(note => note.pitch === 36).map(note => note.start), [0, 2, 3]);
});

test("hip-hop syncopation stays explicit rather than becoming a universal style rule", () => {
  const plan = planDrumPattern(reference, { grid: "straight16", bars: 2, lanes: [
    { role: "kick", note: 36, activeSteps: [1, 7, 10, 15], velocity: 108, gate: 0.5 },
    { role: "snare", note: 38, activeSteps: [5, 13], velocity: 104, gate: 0.5 }
  ] });
  assert.deepEqual(plan.notes.filter(note => note.pitch === 38).map(note => note.start), [1, 3, 5, 7]);
  assert.deepEqual(plan.lanes.find(lane => lane.role === "kick").activeSteps, [1, 7, 10, 15]);
});

test("trap rolls can use sixteenth triplets without becoming a style default", () => {
  const plan = planDrumPattern(reference, { grid: "sixteenthTriplet", bars: 1, lanes: [
    { role: "kick", note: 36, activeSteps: [1, 10, 16], velocity: 110, gate: 0.5 },
    { role: "snare", note: 38, activeSteps: [13], velocity: 105, gate: 0.5 },
    { role: "closed_hat", note: 42, activeSteps: [1, 4, 7, 10, 13, 14, 15, 16, 19, 22],
      velocity: 72, accentSteps: [1, 7, 13, 19], accentVelocity: 92, gate: 0.25 }
  ] });
  assert.equal(plan.stepBeats, 1 / 6);
  assert.deepEqual(plan.notes.filter(note => note.pitch === 38).map(note => note.start), [2]);
  assert.deepEqual(plan.lanes.find(lane => lane.role === "closed_hat").activeSteps,
    [1, 4, 7, 10, 13, 14, 15, 16, 19, 22]);
});

test("guarded drum clip creation verifies every native note", async () => {
  let stateVersion = 80;
  let requestedNotes = [];
  const context = () => ({ stateVersion, timeSignature: reference.timeSignature, key: {} });
  const bridge = { async request(method, args) {
    if (method === "get_live_state") return { stateVersion, setFingerprint: "set:drums", tempo: 120 };
    if (method === "get_song_musical_context") return context();
    if (method === "list_clips") return { stateVersion, trackId: args.trackId,
      clips: [{ id: "track-0:clip-0", name: null, hasClip: false }] };
    if (method === "create_midi_clip") {
      requestedNotes = args.notes;
      stateVersion++;
      return { stateVersion, trackId: args.trackId,
        clip: { id: args.clipId, name: args.name, hasClip: true, lengthBeats: args.lengthBeats,
          noteCount: args.notes.length } };
    }
    if (method === "get_midi_clip_notes_extended") return { stateVersion, trackId: args.trackId,
      clipId: args.clipId, lengthBeats: 4,
      notes: requestedNotes.map((note, index) => ({ ...note, noteId: index + 1 })) };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const args = { expectedStateVersion: 80, trackId: "track-0", clipId: "track-0:clip-0", name: "Drums",
    grid: "straight16", bars: 1, lanes: [
      { role: "kick", note: 36, activeSteps: [1, 5, 9, 13], velocity: 110, gate: 0.5 },
      { role: "snare", note: 38, activeSteps: [5, 13], velocity: 105, gate: 0.5 }
    ] };
  const dry = await service.call("create_drum_pattern_clip", args);
  const result = await service.call("create_drum_pattern_clip", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.clip.noteCount, 6);
  assert.equal(result.verification.matchesRequestedNotes, true);
});

test("drum tools expose strict planner and guarded creator contracts", () => {
  const lane = { role: "kick", note: 36, activeSteps: [1, 5, 9, 13], velocity: 110, gate: 0.5 };
  assert.deepEqual(validateToolArguments("plan_drum_pattern", {
    grid: "straight16", bars: 1, lanes: [lane]
  }).lanes, [lane]);
  assert.equal(validateToolArguments("create_drum_pattern_clip", {
    expectedStateVersion: 80, trackId: "track-0", clipId: "track-0:clip-0", name: "Drums",
    grid: "straight16", bars: 1, lanes: [lane]
  }).expectedStateVersion, 80);
  assert.throws(() => validateToolArguments("plan_drum_pattern", {
    grid: "straight16", bars: 1, lanes: [{ ...lane, extra: true }]
  }), /invalid tool arguments/);
});
