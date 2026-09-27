import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMidiFeel } from "../src/midi-feel-analysis.mjs";

test("each bar in a two-bar MIDI feel cycle marks its own downbeat", () => {
  const observed = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", lengthBeats: 8,
    notes: [{ noteId: 1, pitch: 36, start: 0, velocity: 100 },
      { noteId: 2, pitch: 36, start: 4, velocity: 105 }] };
  const timing = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0",
    timeSignature: { numerator: 4, denominator: 4 }, grooveId: null };
  const result = analyzeMidiFeel(observed, timing, { grid: "straight16", bars: 2 });
  assert.deepEqual(result.slots.map(slot => [slot.slot, slot.barDownbeat]), [[0, true], [16, true]]);
});

test("MIDI feel analysis rejects a triplet grid that cannot divide each bar", () => {
  const observed = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", lengthBeats: 5,
    notes: [{ noteId: 1, pitch: 36, start: 0, velocity: 100 }] };
  const timing = { timeSignature: { numerator: 5, denominator: 16 }, grooveId: null };
  assert.throws(() => analyzeMidiFeel(observed, timing, { grid: "eighthTriplet", bars: 4 }),
    /does not divide/);
});
