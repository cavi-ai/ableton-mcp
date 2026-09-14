import test from "node:test";
import assert from "node:assert/strict";
import { estimateMonophonicPitch } from "../src/audio-pitch.mjs";

test("pitch estimation identifies periodicity rather than the strongest harmonic", () => {
  const samples = Float64Array.from({ length: 4096 }, (_, i) =>
    0.2 * Math.sin(2 * Math.PI * 220 * i / 48000) + 0.6 * Math.sin(2 * Math.PI * 440 * i / 48000));
  const result = estimateMonophonicPitch(samples, 48000);
  assert.ok(Math.abs(result.frequencyHz - 220) < 0.5);
  assert.ok(result.periodicityConfidence > 0.9);
});

test("silence does not produce a pitch", () => {
  assert.equal(estimateMonophonicPitch(new Float64Array(4096), 48000), null);
});
