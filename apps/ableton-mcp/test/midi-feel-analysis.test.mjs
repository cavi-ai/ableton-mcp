import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMidiFeel, planMidiFeelTransfer } from "../src/midi-feel-analysis.mjs";

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

test("MIDI feel transfer refuses a template without source identity", () => {
  const observed = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", lengthBeats: 4,
    notes: [{ noteId: 7, pitch: 42, start: 0.22, duration: 0.1, velocity: 50 }] };
  const timing = { timeSignature: { numerator: 4, denominator: 4 }, grooveId: null };
  const template = { format: "cavi-midi-feel-v1", grid: "straight16", bars: 1, barBeats: 4,
    nativeGrooveId: null, slots: [{ slot: 1, hitCount: 1, meanOffsetBeats: 0.01, meanVelocity: 90 }] };
  assert.throws(() => planMidiFeelTransfer(observed, timing, {
    template, timingAmount: 1, velocityAmount: 1
  }), /source identity/);
});

test("audio feel transfers reliable timing only and never infers MIDI velocity", () => {
  const observed = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", lengthBeats: 4,
    notes: [{ noteId: 7, pitch: 42, start: 0.25, duration: 0.1, velocity: 50 },
      { noteId: 8, pitch: 42, start: 0.5, duration: 0.1, velocity: 60 }] };
  const timing = { timeSignature: { numerator: 4, denominator: 4 }, grooveId: null };
  const template = { format: "cavi-audio-feel-v1", gridBeats: 0.25, bars: 1, barBeats: 4,
    nativeGrooveId: null,
    source: { trackId: "track-1", clipId: "track-1:clip-0", stateVersion: 4, sourcePath: "/audio/source.wav" },
    slots: [{ slot: 1, hitCount: 1, reliableTimingHits: 1, meanOffsetBeats: 0.04, meanStrength: 0.7 },
      { slot: 2, hitCount: 1, reliableTimingHits: 0, meanOffsetBeats: null, meanStrength: 0.5 }] };
  assert.deepEqual(planMidiFeelTransfer(observed, timing, {
    template, timingAmount: 1, velocityAmount: 0
  }), [{ noteId: 7, start: 0.29 }]);
  assert.throws(() => planMidiFeelTransfer(observed, timing, {
    template, timingAmount: 1, velocityAmount: 0.2
  }), /audio feel.*velocity/i);
});
