import test from "node:test";
import assert from "node:assert/strict";
import { matchDrumPatternEditReadback, planDrumPattern, planDrumPatternEdit } from "../src/drum-pattern.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";
import { buildSongGridReference } from "../src/song-grid-reference.mjs";

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
  assert.equal(validateToolArguments("plan_drum_pattern_edit", {
    trackId: "track-0", clipId: "track-0:clip-0", grid: "straight16", startBar: 0, bars: 1,
    lanes: [{ ...lane, activeSteps: [] }]
  }).lanes[0].activeSteps.length, 0);
  assert.equal(validateToolArguments("edit_drum_pattern_clip", {
    expectedStateVersion: 80, trackId: "track-0", clipId: "track-0:clip-0", grid: "straight16",
    startBar: 0, bars: 1, lanes: [lane]
  }).expectedStateVersion, 80);
  assert.throws(() => validateToolArguments("plan_drum_pattern", {
    grid: "straight16", bars: 1, lanes: [{ ...lane, extra: true }]
  }), /invalid tool arguments/);
});

test("drum edits replace only selected lanes inside the requested bar range", () => {
  const observed = { lengthBeats: 8, notes: [
    { noteId: 1, pitch: 36, start: 0, duration: 0.125, velocity: 100, mute: false },
    { noteId: 2, pitch: 38, start: 1, duration: 0.125, velocity: 100, mute: false },
    { noteId: 3, pitch: 42, start: 0.5, duration: 0.125, velocity: 70, mute: false },
    { noteId: 4, pitch: 36, start: 4, duration: 0.125, velocity: 100, mute: false }
  ] };
  const edit = planDrumPatternEdit(reference, observed, {
    grid: "straight16", startBar: 0, bars: 1, lanes: [
      { role: "kick", note: 36, activeSteps: [1, 7, 9, 13], velocity: 110, gate: 0.5 },
      { role: "snare", note: 38, activeSteps: [], velocity: 105, gate: 0.5 }
    ]
  });
  assert.deepEqual(edit.removeNoteIds, [1, 2]);
  assert.equal(edit.newNotes.length, 4);
  assert.deepEqual(edit.preservedNotes.map(note => note.noteId), [3, 4]);
  assert.equal(edit.range.startBeat, 0);
  assert.equal(edit.range.endBeat, 4);
});

test("drum edits reject target-lane notes crossing the edit boundary", () => {
  assert.throws(() => planDrumPatternEdit(reference, { lengthBeats: 8, notes: [
    { noteId: 9, pitch: 42, start: 3.9, duration: 0.2, velocity: 70, mute: false }
  ] }, { grid: "straight16", startBar: 1, bars: 1, lanes: [
    { role: "hat", note: 42, activeSteps: [1], velocity: 80, gate: 0.5 }
  ] }), /crosses the edit boundary/);
  assert.throws(() => planDrumPatternEdit(reference, { lengthBeats: 4, notes: [] }, {
    grid: "straight16", startBar: 0, bars: 1, lanes: [
      { role: "snare", note: 38, activeSteps: [], velocity: 100, gate: 0.5 }
    ]
  }), /would not change any notes/);
});

test("drum edits use the clip-local meter and cap total mutation size", () => {
  const clipReference = buildSongGridReference({ numerator: 3, denominator: 4 }, 120);
  const edit = planDrumPatternEdit(clipReference, { lengthBeats: 6, notes: [] }, {
    grid: "straight16", startBar: 1, bars: 1, lanes: [
      { role: "snare", note: 38, activeSteps: [1], velocity: 100, gate: 0.5 }
    ]
  });
  assert.equal(edit.range.startBeat, 3);
  assert.equal(edit.newNotes[0].start, 3);
  assert.throws(() => planDrumPatternEdit(reference, { lengthBeats: 4,
    notes: Array.from({ length: 4097 }, (_, noteId) => ({ noteId, pitch: 42, start: 0,
      duration: 0.1, velocity: 80, velocityDeviation: 0, releaseVelocity: 0,
      probability: 1, mute: false })) }, {
    grid: "straight16", startBar: 0, bars: 1, lanes: [
      { role: "kick", note: 36, activeSteps: [1], velocity: 100, gate: 0.5 }
    ]
  }), /at most 4096 existing MIDI notes/);
});

test("drum edit readback verifies preserved expression and exact added IDs", () => {
  const preserved = { noteId: 8, pitch: 42, start: 0.5, duration: 0.125, velocity: 70,
    velocityDeviation: -4, releaseVelocity: 63, probability: 0.75, mute: false };
  const added = { noteId: 100, pitch: 36, start: 0, duration: 0.125, velocity: 110,
    velocityDeviation: 0, releaseVelocity: 0, probability: 1, mute: false };
  const edit = { preservedNotes: [preserved], newNotes: [{ pitch: 36, start: 0,
    duration: 0.125, velocity: 110, mute: false }] };
  assert.equal(matchDrumPatternEditReadback(edit, { addedNoteIds: [100] }, [preserved, added]), true);
  assert.equal(matchDrumPatternEditReadback(edit, { addedNoteIds: [100] }, [
    { ...preserved, probability: 1 }, added
  ]), false);
  assert.equal(matchDrumPatternEditReadback(edit, { addedNoteIds: [101] }, [preserved, added]), false);
});

test("guarded drum edits preserve unrelated notes and verify native replacement", async () => {
  let stateVersion = 80;
  let notes = [
    { noteId: 1, pitch: 36, start: 0, duration: 0.125, velocity: 100, velocityDeviation: 0,
      releaseVelocity: 64, probability: 1, mute: false },
    { noteId: 2, pitch: 42, start: 0.5, duration: 0.125, velocity: 70, velocityDeviation: 0,
      releaseVelocity: 64, probability: 1, mute: false }
  ];
  const bridge = { async request(method, args) {
    if (method === "get_live_state") return { stateVersion, setFingerprint: "set:drum-edit", tempo: 120 };
    if (method === "get_song_musical_context") return { stateVersion, timeSignature: reference.timeSignature, key: {} };
    if (method === "get_clip_timing") return { stateVersion, trackId: args.trackId, clipId: args.clipId,
      timeSignature: reference.timeSignature };
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4, notes
    };
    if (method === "replace_midi_notes") {
      notes = notes.filter(note => !args.removeNoteIds.includes(note.noteId)).concat(
        args.newNotes.map((note, index) => ({ ...note, noteId: 100 + index, velocityDeviation: 0,
          releaseVelocity: 0, probability: 1 })));
      stateVersion++;
      return { stateVersion, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4,
        removedNoteIds: args.removeNoteIds, addedNoteIds: args.newNotes.map((_, index) => 100 + index), notes };
    }
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const args = { expectedStateVersion: 80, trackId: "track-0", clipId: "track-0:clip-0",
    grid: "straight16", startBar: 0, bars: 1, lanes: [
      { role: "kick", note: 36, activeSteps: [1, 5, 9, 13], velocity: 110, gate: 0.5 }
    ] };
  const dry = await service.call("edit_drum_pattern_clip", args);
  assert.deepEqual(dry.plan.removeNoteIds, [1]);
  const result = await service.call("edit_drum_pattern_clip", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.verification.matchesExpectedNotes, true);
  assert.equal(result.verification.notes.notes.some(note => note.noteId === 2), true);
  assert.equal(result.verification.notes.notes.filter(note => note.pitch === 36).length, 4);
});
