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

test("unvoiced noise is rejected while low bass periodicity is resolved", () => {
  let seed = 123456789;
  const noise = Float64Array.from({ length: 4096 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  });
  assert.equal(estimateMonophonicPitch(noise, 48000), null);
  const bass = Float64Array.from({ length: 4096 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 55 * i / 48000));
  const pitch = estimateMonophonicPitch(bass, 48000);
  assert.ok(Math.abs(pitch.frequencyHz - 55) < 0.1);
  assert.equal(pitch.pitchReference.noteName, "A1");
});
