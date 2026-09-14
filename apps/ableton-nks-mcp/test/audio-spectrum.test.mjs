import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSpectrum } from "../src/audio-spectrum.mjs";

test("spectral peaks resolve a known tone and preserve amplitude scale", () => {
  const samples = Float64Array.from({ length: 4096 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / 4096));
  const result = analyzeSpectrum(samples, 4096);
  assert.equal(result.peaks[0].frequencyHz, 440);
  assert.ok(Math.abs(result.peaks[0].amplitudeDbfs + 6.0206) < 0.01);
  assert.equal(result.frequencyResolutionHz, 1);
});

test("spectral silence has no peaks and invalid frames are rejected", () => {
  assert.deepEqual(analyzeSpectrum(new Float64Array(1024), 48000).peaks, []);
  assert.throws(() => analyzeSpectrum([0, 1, 0], 48000), /power of two/);
  assert.throws(() => analyzeSpectrum(new Float64Array(1024), 0), /sample rate/);
});
