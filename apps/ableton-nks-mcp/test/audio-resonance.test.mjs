import test from "node:test";
import assert from "node:assert/strict";
import { inspectSpectralPersistence } from "../src/audio-resonance.mjs";

const frames = () => Array.from({ length: 8 }, (_, i) => ({ startSeconds: i * .1, amplitudesDbfs: Array(33).fill(-80) }));

test("persistent narrow spectral peaks are candidates, not confirmed resonances", () => {
  const input = frames();
  for (const frame of input) frame.amplitudesDbfs[12] = -20;
  input[0].amplitudesDbfs[22] = -10;
  const result = inspectSpectralPersistence({ sampleRate: 6400, frameSize: 64, frames: input });
  assert.equal(result.confirmedResonance, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].frequencyHz, 1200);
  assert.equal(result.candidates[0].observedFrameFraction, 1);
  assert.equal(result.candidates[0].medianProminenceDb, 60);
});

test("flat spectra, silence and insufficient temporal evidence do not produce resonance claims", () => {
  assert.deepEqual(inspectSpectralPersistence({ sampleRate: 6400, frameSize: 64, frames: frames() }).candidates, []);
  const silent = frames();
  for (const frame of silent) frame.amplitudesDbfs.fill(-120);
  assert.deepEqual(inspectSpectralPersistence({ sampleRate: 6400, frameSize: 64, frames: silent }).candidates, []);
  assert.throws(() => inspectSpectralPersistence({ sampleRate: 6400, frameSize: 64, frames: frames().slice(0, 3) }), /four/);
  const malformed = frames(); malformed[0].amplitudesDbfs[0] = NaN;
  assert.throws(() => inspectSpectralPersistence({ sampleRate: 6400, frameSize: 64, frames: malformed }), /finite/);
});
