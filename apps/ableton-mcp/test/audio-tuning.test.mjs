import test from "node:test";
import assert from "node:assert/strict";
import { measureTargetNoteDeviation } from "../src/audio-tuning.mjs";

test("target-note tuning preserves octave errors and missing periodicity", () => {
  const frames = [{ startSeconds: 0, endSeconds: .256, estimate: { frequencyHz: 440 * 2 ** (25 / 1200) } },
    { startSeconds: .128, endSeconds: .384, estimate: null },
    { startSeconds: .256, endSeconds: .512, estimate: { frequencyHz: 880 } }];
  const result = measureTargetNoteDeviation(frames, 69);
  assert.ok(Math.abs(result.frames[0].centsFromTarget - 25) < 1e-8);
  assert.equal(result.frames[1].centsFromTarget, null);
  assert.equal(result.frames[2].centsFromTarget, 1200);
  assert.equal(result.measuredFrameFraction, 2 / 3);
  assert.equal(result.pitchCorrectionApplied, false);
  assert.throws(() => measureTargetNoteDeviation(frames, 69.5), /MIDI/);
});

test("unvoiced tuning measurements remain unavailable rather than zero", () => {
  const result = measureTargetNoteDeviation([{ startSeconds: 0, endSeconds: .256, estimate: null }], 60);
  assert.equal(result.medianCentsFromTarget, null);
  assert.equal(result.medianAbsoluteCentsFromTarget, null);
  assert.equal(result.measuredFrameFraction, 0);
});
