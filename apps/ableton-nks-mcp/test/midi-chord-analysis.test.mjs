import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMidiChordEvents } from "../src/midi-chord-analysis.mjs";
import { ToolService } from "../src/tool-service.mjs";

const cMajor = { rootNote: 0, rootName: "C", scaleName: "Major", scaleMode: true,
  scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };

function note(noteId, pitch, start, duration = 1, mute = false) {
  return { noteId, pitch, start, duration, velocity: 100, velocityDeviation: 0,
    releaseVelocity: 64, probability: 1, mute };
}

test("chord analysis identifies function and inversion from literal MIDI pitches", () => {
  const result = analyzeMidiChordEvents([
    note(1, 64, 0), note(2, 67, 0), note(3, 72, 0),
    note(4, 62, 2), note(5, 65, 2), note(6, 69, 2), note(7, 72, 2)
  ], cMajor);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[0].candidates[0], {
    name: "C major", symbol: "C", rootPitchClass: 0, rootName: "C", quality: "major",
    intervals: [0, 4, 7], inversion: 1, bassPitchClass: 4, bassName: "E",
    romanNumeral: "I", rootDegree: 1, inScale: true
  });
  assert.deepEqual(result.events[1].candidates[0], {
    name: "D minor 7", symbol: "Dm7", rootPitchClass: 2, rootName: "D", quality: "minor 7",
    intervals: [0, 3, 7, 10], inversion: 0, bassPitchClass: 2, bassName: "D",
    romanNumeral: "ii7", rootDegree: 2, inScale: true
  });
});

test("sustained notes join later attacks and muted notes do not create harmony", () => {
  const result = analyzeMidiChordEvents([
    note(1, 60, 0, 4), note(2, 64, 1, 2), note(3, 67, 1, 2), note(4, 70, 1, 2, true)
  ], cMajor);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].startBeats, 1);
  assert.deepEqual(result.events[0].noteIds, [1, 2, 3]);
  assert.equal(result.events[0].candidates[0].symbol, "C");
});

test("a repeated chord with a new bass is retained as an inversion change", () => {
  const result = analyzeMidiChordEvents([
    note(1, 60, 0), note(2, 64, 0), note(3, 67, 0),
    note(4, 52, 2), note(5, 60, 2), note(6, 67, 2)
  ], cMajor);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map(event => event.candidates[0].inversion), [0, 1]);
});

test("symmetrical chords retain ranked ambiguity instead of inventing certainty", () => {
  const result = analyzeMidiChordEvents([
    note(1, 64, 0), note(2, 68, 0), note(3, 72, 0)
  ], cMajor);
  assert.deepEqual(result.events[0].candidates.map(candidate => candidate.symbol), ["E+", "C+", "G#/Ab+"]);
  assert.equal(result.events[0].ambiguous, true);
  assert.deepEqual(result.events[0].chromaticPitchClasses, [8]);
});

test("unknown sonorities remain explicit and malformed notes fail closed", () => {
  const unknown = analyzeMidiChordEvents([
    note(1, 60, 0), note(2, 61, 0), note(3, 66, 0)
  ], cMajor).events[0];
  assert.equal(unknown.unknown, true);
  assert.deepEqual(unknown.candidates, []);
  assert.throws(() => analyzeMidiChordEvents([note(1, 60, -1)], cMajor), /start/);
  assert.throws(() => analyzeMidiChordEvents([note(1, 60, 0, 0)], cMajor), /duration/);
});

test("MCP chord analysis binds one unchanged song context to one exact clip snapshot", async () => {
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: 12, key: cMajor };
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: 12, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4,
      notes: [note(1, 60, 0), note(2, 64, 0), note(3, 67, 0)]
    };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const result = await service.call("analyze_midi_clip_chords", {
    trackId: "track-0", clipId: "track-0:clip-0"
  });
  assert.equal(result.stateVersion, 12);
  assert.equal(result.analysis.events[0].candidates[0].romanNumeral, "I");
});

test("MCP chord analysis rejects a changed song or clip snapshot", async () => {
  let version = 3;
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: version++, key: cMajor };
    return { stateVersion: 3, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4, notes: [] };
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  await assert.rejects(() => service.call("analyze_midi_clip_chords", {
    trackId: "track-0", clipId: "track-0:clip-0"
  }), /changed during chord analysis/);
});
