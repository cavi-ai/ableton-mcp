import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiNoteReadback, planScaleChordProgression } from "../src/scale-chord-progression.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

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

test("scale progression creates secondary dominants and parallel-minor borrowed chords", () => {
  const result = planScaleChordProgression(cMajor, {
    ...base,
    degrees: [2, 4, 5],
    chordRecipes: ["dominant7", "triad", "triad"],
    harmonicFunctions: ["secondary_dominant", "borrowed_parallel_minor", "diatonic"],
    minPitch: 48,
    maxPitch: 84,
    voiceLeading: "root_position"
  });
  assert.deepEqual(result.chords.map(chord => ({
    degree: chord.degree,
    recipe: chord.recipe,
    harmonicFunction: chord.harmonicFunction,
    pitches: chord.pitches,
    rootPitchClass: chord.rootPitchClass
  })), [
    { degree: 2, recipe: "dominant7", harmonicFunction: "secondary_dominant",
      pitches: [57, 61, 64, 67], rootPitchClass: 9 },
    { degree: 4, recipe: "triad", harmonicFunction: "borrowed_parallel_minor",
      pitches: [53, 56, 60], rootPitchClass: 5 },
    { degree: 5, recipe: "triad", harmonicFunction: "diatonic",
      pitches: [55, 59, 62], rootPitchClass: 7 }
  ]);
  assert.equal(result.notes.length, 10);
  assert.deepEqual({ startBeats: result.startBeats, chordBeats: result.chordBeats,
    velocity: result.velocity, minPitch: result.minPitch, maxPitch: result.maxPitch },
  { startBeats: 0, chordBeats: 2, velocity: 96, minPitch: 48, maxPitch: 84 });
});

test("functional progression rejects incompatible recipe and function sequences", () => {
  assert.throws(() => planScaleChordProgression(cMajor, {
    ...base,
    degrees: [2],
    chordRecipes: ["triad"],
    harmonicFunctions: ["secondary_dominant"]
  }), /secondary dominant requires a dominant recipe/);
  assert.throws(() => planScaleChordProgression(cMajor, {
    ...base,
    degrees: [4, 5],
    chordRecipes: ["triad"],
    harmonicFunctions: ["borrowed_parallel_minor", "diatonic"]
  }), /one chord recipe per degree/);
});

test("functional progression tool contracts accept only supported recipes and functions", () => {
  const functional = { ...base, degrees: [2], chordRecipes: ["dominant7"],
    harmonicFunctions: ["secondary_dominant"] };
  assert.deepEqual(validateToolArguments("plan_scale_chord_progression", functional).chordRecipes, ["dominant7"]);
  assert.equal(validateToolArguments("create_scale_chord_progression_clip", {
    ...functional, trackId: "track-0", clipId: "track-0:clip-0", name: "V of ii",
    expectedStateVersion: 7
  }).harmonicFunctions[0], "secondary_dominant");
  assert.throws(() => validateToolArguments("plan_scale_chord_progression", {
    ...functional, harmonicFunctions: ["chromatic_mediant"]
  }), /invalid tool arguments/);
});

test("root-position mode never substitutes an inversion", () => {
  const result = planScaleChordProgression(cMajor, { ...base, degrees: [5, 4], voiceLeading: "root_position" });
  assert.deepEqual(result.chords.map(chord => chord.inversion), [0, 0]);
});

test("pulse articulation repeats every voicing on a straight grid", () => {
  const result = planScaleChordProgression(cMajor, {
    ...base, degrees: [1], chordBeats: 2,
    articulation: { mode: "pulse", stepBeats: 0.5, gate: 0.5 }
  });
  assert.deepEqual(result.articulation, {
    mode: "pulse", stepBeats: 0.5, gate: 0.5, stepsPerChord: 4
  });
  assert.equal(result.notes.length, 12);
  assert.deepEqual(result.notes.slice(0, 4), [
    { pitch: 60, start: 0, duration: 0.25, velocity: 96, mute: false },
    { pitch: 64, start: 0, duration: 0.25, velocity: 96, mute: false },
    { pitch: 67, start: 0, duration: 0.25, velocity: 96, mute: false },
    { pitch: 60, start: 0.5, duration: 0.25, velocity: 96, mute: false }
  ]);
});

test("arpeggio articulation cycles chord tones on a triplet grid", () => {
  const stepBeats = 1 / 3;
  const result = planScaleChordProgression(cMajor, {
    ...base, degrees: [1], chordBeats: 2,
    articulation: { mode: "arpeggio_down", stepBeats, gate: 0.75 }
  });
  assert.equal(result.articulation.stepsPerChord, 6);
  assert.deepEqual(result.notes.map(note => note.pitch), [67, 64, 60, 67, 64, 60]);
  assert.deepEqual(result.notes.map(note => note.start), [0, stepBeats, 2 * stepBeats, 1, 4 * stepBeats, 5 * stepBeats]);
  assert.ok(result.notes.every(note => Math.abs(note.duration - 0.25) < 1e-12));
});

test("articulation rejects drifting grids and invalid gates", () => {
  assert.throws(() => planScaleChordProgression(cMajor, {
    ...base, articulation: { mode: "pulse", stepBeats: 0.3, gate: 1 }
  }), /divide chordBeats exactly/);
  assert.throws(() => planScaleChordProgression(cMajor, {
    ...base, articulation: { mode: "pulse", stepBeats: 0.5, gate: 0 }
  }), /gate/);
  assert.throws(() => planScaleChordProgression(cMajor, {
    ...base, degrees: Array(64).fill(1), notesPerChord: 4, chordBeats: 4,
    articulation: { mode: "pulse", stepBeats: 1 / 32, gate: 1 }
  }), /4096 MIDI notes/);
});

test("native readback matching is order-independent within tight beat tolerance", () => {
  const expected = [
    { pitch: 60, start: 1, duration: 0.5, velocity: 96, mute: false },
    { pitch: 64, start: 1, duration: 0.5, velocity: 96, mute: false }
  ];
  const reordered = [
    { pitch: 64, start: 1 - 5e-10, duration: 0.5, velocity: 96, mute: false },
    { pitch: 60, start: 1 + 5e-10, duration: 0.5, velocity: 96, mute: false }
  ];
  assert.equal(matchMidiNoteReadback(expected, reordered), true);
  assert.equal(matchMidiNoteReadback(expected, [reordered[0], { ...reordered[1], start: 1 + 2e-9 }]), false);
  const repeated = [
    { pitch: 60, start: 0, duration: 0.25, velocity: 96, mute: false },
    { pitch: 60, start: 1.5e-9, duration: 0.25, velocity: 96, mute: false }
  ];
  assert.equal(matchMidiNoteReadback(repeated, [
    { ...repeated[0], start: 1e-9 },
    { ...repeated[0], start: 0 }
  ]), true);
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

test("guarded triplet arpeggio accepts only sub-nanobeat native normalization", async () => {
  let created = false;
  let requestedNotes = [];
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: created ? 61 : 60, key: cMajor };
    if (method === "list_clips") return { stateVersion: 60, trackId: args.trackId,
      clips: [{ id: "track-0:clip-0", name: null, hasClip: false }] };
    if (method === "create_midi_clip") {
      created = true;
      requestedNotes = args.notes;
      return { stateVersion: 61, trackId: args.trackId,
        clip: { id: args.clipId, name: args.name, hasClip: true, lengthBeats: args.lengthBeats, noteCount: args.notes.length } };
    }
    if (method === "get_midi_clip_notes_extended") return { stateVersion: 61, trackId: args.trackId,
      clipId: args.clipId, lengthBeats: 2, notes: requestedNotes.map((note, index) => ({
        ...note, noteId: index + 1, start: note.start + (index === 4 ? 2e-16 : 0)
      })) };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const args = { ...base, degrees: [1], chordBeats: 2, expectedStateVersion: 60,
    trackId: "track-0", clipId: "track-0:clip-0", name: "Triplet arp",
    articulation: { mode: "arpeggio_down", stepBeats: 1 / 3, gate: 0.75 } };
  const dry = await service.call("create_scale_chord_progression_clip", args);
  const live = await service.call("create_scale_chord_progression_clip", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.verification.matchesRequestedNotes, true);
  assert.equal(live.verification.harmonicReadbackSupported, false);
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
