import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMidiNotesAgainstScale, planMidiScaleCorrections } from "../src/midi-scale-analysis.mjs";
import { ToolService } from "../src/tool-service.mjs";

const cMajor = { rootNote: 0, rootName: "C", scaleName: "Major", scaleMode: true,
  scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };

test("MIDI scale analysis assigns degrees and bounded correction candidates", () => {
  const result = analyzeMidiNotesAgainstScale([
    { noteId: 1, pitch: 60, mute: false },
    { noteId: 2, pitch: 61, mute: false },
    { noteId: 3, pitch: 71, mute: true },
    { noteId: 4, pitch: 127, mute: false }
  ], cMajor);
  assert.deepEqual(result.notes[0], {
    noteId: 1, pitch: 60, noteName: "C3", pitchClass: 0, octave: 3,
    inScale: true, degree: 1, mute: false, corrections: null
  });
  assert.deepEqual(result.notes[1].corrections, {
    lower: { pitch: 60, noteName: "C3", semitones: -1, degree: 1 },
    upper: { pitch: 62, noteName: "D3", semitones: 1, degree: 2 },
    nearest: [
      { pitch: 60, noteName: "C3", semitones: -1, degree: 1 },
      { pitch: 62, noteName: "D3", semitones: 1, degree: 2 }
    ]
  });
  assert.equal(result.notes[2].degree, 7);
  assert.equal(result.notes[3].degree, 5);
  assert.deepEqual(result.summary, {
    totalNotes: 4, inScaleNotes: 3, offScaleNotes: 1,
    mutedNotes: 1, usedDegrees: [1, 5, 7], chromaticNoteIds: [2],
    pitchRange: { lowest: 60, highest: 127 }
  });
});

test("correction candidates respect MIDI range boundaries", () => {
  const low = analyzeMidiNotesAgainstScale([{ noteId: 1, pitch: 0, mute: false }], {
    rootNote: 2, rootName: "D", scaleName: "Major", scaleMode: true,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11]
  }).notes[0];
  assert.equal(low.corrections.lower, null);
  assert.equal(low.corrections.upper.pitch, 1);
  assert.deepEqual(low.corrections.nearest, [low.corrections.upper]);
});

test("scale analysis rejects malformed notes and mismatched scale intervals", () => {
  assert.throws(() => analyzeMidiNotesAgainstScale([{ noteId: 1, pitch: 128 }], cMajor), /pitch/);
  assert.throws(() => analyzeMidiNotesAgainstScale([], { ...cMajor, scaleIntervals: [0, 3, 7] }), /intervals/);
});

test("MCP scale analysis binds one unchanged song context to one exact clip snapshot", async () => {
  let reads = 0;
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") {
      reads += 1;
      return { stateVersion: 8, key: cMajor };
    }
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: 8, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4,
      notes: [{ noteId: 9, pitch: 61, start: 0, duration: 1, velocity: 100,
        velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }]
    };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const result = await service.call("analyze_midi_clip_scale", {
    trackId: "track-0", clipId: "track-0:clip-0"
  });
  assert.equal(reads, 2);
  assert.equal(result.stateVersion, 8);
  assert.equal(result.analysis.notes[0].inScale, false);
  assert.deepEqual(result.analysis.summary.chromaticNoteIds, [9]);
});

test("MCP scale analysis rejects changed song or clip state", async () => {
  let version = 4;
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: version++, key: cMajor };
    return { stateVersion: 4, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4, notes: [] };
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  await assert.rejects(() => service.call("analyze_midi_clip_scale", {
    trackId: "track-0", clipId: "track-0:clip-0"
  }), /changed during scale analysis/);
});

test("scale correction plans explicit up, down, and nearest pitch changes", () => {
  const analysis = analyzeMidiNotesAgainstScale([
    { noteId: 1, pitch: 61, mute: false },
    { noteId: 2, pitch: 63, mute: false },
    { noteId: 3, pitch: 64, mute: false }
  ], cMajor);
  assert.deepEqual(planMidiScaleCorrections(analysis, [1], "down"), [
    { noteId: 1, previous: { pitch: 61, noteName: "C#/Db3" }, pitch: 60, noteName: "C3", degree: 1, semitones: -1 }
  ]);
  assert.equal(planMidiScaleCorrections(analysis, [2], "up")[0].pitch, 64);
  assert.throws(() => planMidiScaleCorrections(analysis, [1], "nearest"), /tieBreak/);
  assert.equal(planMidiScaleCorrections(analysis, [1], "nearest", "up")[0].pitch, 62);
  assert.throws(() => planMidiScaleCorrections(analysis, [3], "down"), /already in scale/);
});

test("guarded MCP scale correction binds scale, notes, policy, and native readback", async () => {
  const notes = [{ noteId: 9, pitch: 61, start: 0, duration: 1, velocity: 100,
    velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }];
  const calls = [];
  const bridge = { async request(method, args) {
    calls.push({ method, args });
    if (method === "get_song_musical_context") return { stateVersion: 8, key: cMajor };
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: 8, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4, notes
    };
    if (method === "set_midi_note_properties") return {
      stateVersion: 9, trackId: args.trackId, clipId: args.clipId,
      notes: args.changes.map(change => ({ ...notes[0], pitch: change.pitch }))
    };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const args = { expectedStateVersion: 8, trackId: "track-0", clipId: "track-0:clip-0",
    noteIds: [9], direction: "nearest", tieBreak: "down" };
  const dry = await service.call("correct_midi_clip_to_scale", args);
  assert.equal(dry.plan.scale.scaleName, "Major");
  assert.equal(dry.plan.changes[0].pitch, 60);
  assert.equal(dry.plan.changes[0].previous.pitch, 61);
  const live = await service.call("correct_midi_clip_to_scale", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.notes[0].pitch, 60);
  assert.equal(calls.at(-1).method, "set_midi_note_properties");
});

test("scale correction rejects stale state, unknown IDs, and no-op selections", async () => {
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: 5, key: cMajor };
    return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4,
      notes: [{ noteId: 4, pitch: 60, mute: false }] };
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const base = { trackId: "track-0", clipId: "track-0:clip-0", direction: "down" };
  await assert.rejects(() => service.call("correct_midi_clip_to_scale", {
    ...base, expectedStateVersion: 4
  }), /state version/);
  await assert.rejects(() => service.call("correct_midi_clip_to_scale", {
    ...base, expectedStateVersion: 5, noteIds: [99]
  }), /unknown noteId/);
  await assert.rejects(() => service.call("correct_midi_clip_to_scale", {
    ...base, expectedStateVersion: 5, noteIds: [4]
  }), /already in scale/);
});
