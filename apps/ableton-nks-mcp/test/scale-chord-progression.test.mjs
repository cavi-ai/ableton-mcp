import test from "node:test";
import assert from "node:assert/strict";
import { planScaleChordProgression } from "../src/scale-chord-progression.mjs";
import { ToolService } from "../src/tool-service.mjs";

const cMajor = { rootNote: 0, rootName: "C", scaleName: "Major", scaleMode: true,
  scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };
const base = { degrees: [1, 5, 6, 4], notesPerChord: 3, startBeats: 0,
  chordBeats: 2, velocity: 96, minPitch: 48, maxPitch: 72, voiceLeading: "closest" };

test("scale progression emits literal voice-led MIDI notes and harmonic metadata", () => {
  const result = planScaleChordProgression(cMajor, base);
  assert.deepEqual(result.chords.map(chord => ({
    degree: chord.degree, pitches: chord.pitches, inversion: chord.inversion,
    romanNumeral: chord.romanNumeral, movementSemitones: chord.movementSemitones
  })), [
    { degree: 1, pitches: [60, 64, 67], inversion: 0, romanNumeral: "I", movementSemitones: 0 },
    { degree: 5, pitches: [59, 62, 67], inversion: 1, romanNumeral: "V", movementSemitones: 3 },
    { degree: 6, pitches: [60, 64, 69], inversion: 1, romanNumeral: "vi", movementSemitones: 5 },
    { degree: 4, pitches: [60, 65, 69], inversion: 2, romanNumeral: "IV", movementSemitones: 1 }
  ]);
  assert.deepEqual(result.notes.slice(0, 3), [
    { pitch: 60, start: 0, duration: 2, velocity: 96, mute: false },
    { pitch: 64, start: 0, duration: 2, velocity: 96, mute: false },
    { pitch: 67, start: 0, duration: 2, velocity: 96, mute: false }
  ]);
  assert.equal(result.lengthBeats, 8);
});

test("root-position mode never substitutes an inversion", () => {
  const result = planScaleChordProgression(cMajor, { ...base, degrees: [5, 4], voiceLeading: "root_position" });
  assert.deepEqual(result.chords.map(chord => chord.inversion), [0, 0]);
});

test("non-heptatonic Live scales use degree labels without fake Roman numerals", () => {
  const result = planScaleChordProgression({ rootNote: 0, rootName: "C", scaleName: "Minor Pentatonic",
    scaleMode: true, scaleIntervals: [0, 3, 5, 7, 10] }, {
    ...base, degrees: [1, 5], minPitch: 48, maxPitch: 84
  });
  assert.equal(result.scaleSize, 5);
  assert.deepEqual(result.chords.map(chord => chord.degreeLabel), ["degree-1", "degree-5"]);
  assert.deepEqual(result.chords.map(chord => chord.romanNumeral), [null, null]);
  assert.equal(result.notes.length, 6);
});

test("progression planning rejects invalid degrees, timing, and impossible ranges", () => {
  assert.throws(() => planScaleChordProgression(cMajor, { ...base, degrees: [8] }), /degree/);
  assert.throws(() => planScaleChordProgression(cMajor, { ...base, chordBeats: 0 }), /chordBeats/);
  assert.throws(() => planScaleChordProgression(cMajor, { ...base, minPitch: 60, maxPitch: 65 }), /fit/);
});

test("MCP progression planning binds one unchanged native musical context", async () => {
  const bridge = { async request(method) {
    if (method === "get_song_musical_context") return { stateVersion: 21, key: cMajor };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const result = await service.call("plan_scale_chord_progression", base);
  assert.equal(result.stateVersion, 21);
  assert.deepEqual(result.plan.chords.map(chord => chord.romanNumeral), ["I", "V", "vi", "IV"]);
});

test("MCP progression planning rejects a changed musical context", async () => {
  let version = 8;
  const bridge = { async request() { return { stateVersion: version++, key: cMajor }; } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  await assert.rejects(() => service.call("plan_scale_chord_progression", base), /changed during chord progression planning/);
});

test("guarded progression creation verifies native notes and chord functions", async () => {
  let created = false;
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: created ? 31 : 30, key: cMajor };
    if (method === "list_clips") return { stateVersion: 30, trackId: args.trackId,
      clips: [{ id: "track-0:clip-0", name: null, hasClip: false }] };
    if (method === "create_midi_clip") {
      created = true;
      return { stateVersion: 31, trackId: args.trackId,
        clip: { id: args.clipId, name: args.name, hasClip: true, lengthBeats: args.lengthBeats, noteCount: args.notes.length } };
    }
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: 31, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4,
      notes: base.degrees.flatMap((_, chordIndex) => [
        [60, 64, 67], [59, 62, 67], [60, 64, 69], [60, 65, 69]
      ][chordIndex].map((pitch, voiceIndex) => ({ noteId: chordIndex * 3 + voiceIndex + 1,
        pitch, start: chordIndex, duration: 1, velocity: 96, velocityDeviation: 0,
        releaseVelocity: 0, probability: 1, mute: false })))
    };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const args = { ...base, expectedStateVersion: 30, trackId: "track-0", clipId: "track-0:clip-0",
    name: "Voice-led I-V-vi-IV", chordBeats: 1 };
  const dry = await service.call("create_scale_chord_progression_clip", args);
  assert.deepEqual(dry.plan.progression.chords.map(chord => chord.romanNumeral), ["I", "V", "vi", "IV"]);
  const live = await service.call("create_scale_chord_progression_clip", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.clip.noteCount, 12);
  assert.equal(live.verification.matchesRequestedNotes, true);
  assert.deepEqual(live.verification.analysis.events.map(event => event.candidates[0].romanNumeral), ["I", "V", "vi", "IV"]);
});

test("progression creation rejects occupied destinations and mismatched native notes", async () => {
  let created = false;
  let occupied = true;
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: created ? 41 : 40, key: cMajor };
    if (method === "list_clips") return { stateVersion: 40, trackId: args.trackId,
      clips: [{ id: "track-0:clip-0", name: occupied ? "Existing" : null, hasClip: occupied }] };
    if (method === "create_midi_clip") { created = true; return { stateVersion: 41, trackId: args.trackId,
      clip: { id: args.clipId, name: args.name, hasClip: true, lengthBeats: 4, noteCount: args.notes.length } }; }
    if (method === "get_midi_clip_notes_extended") return { stateVersion: 41, trackId: args.trackId,
      clipId: args.clipId, lengthBeats: 4, notes: args.notes ?? [{ noteId: 1, pitch: 61, start: 0,
        duration: 1, velocity: 96, velocityDeviation: 0, releaseVelocity: 0, probability: 1, mute: false }] };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const args = { ...base, expectedStateVersion: 40, trackId: "track-0", clipId: "track-0:clip-0",
    name: "Progression", chordBeats: 1 };
  await assert.rejects(() => service.call("create_scale_chord_progression_clip", args), /already contains a clip/);
  occupied = false;
  const dry = await service.call("create_scale_chord_progression_clip", args);
  await assert.rejects(() => service.call("create_scale_chord_progression_clip", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  }), /note readback mismatch/);
});
