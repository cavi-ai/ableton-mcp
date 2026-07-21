import test from "node:test";
import assert from "node:assert/strict";
import { validatePreviewMeasurement } from "../src/preview-policy.mjs";

test("accepts a conforming preview measurement", () => {
  assert.deepEqual(
    validatePreviewMeasurement({
      durationSeconds: 12,
      sampleRate: 48000,
      bitDepth: 24,
      integratedLufs: -16,
      truePeakDbtp: -1.2
    }),
    { ok: true, findings: [] }
  );
});

test("rejects silence and clipping", () => {
  const result = validatePreviewMeasurement({
    durationSeconds: 12,
    sampleRate: 48000,
    bitDepth: 24,
    integratedLufs: -61,
    truePeakDbtp: 0
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, ["silence", "true_peak_above_-1_dbtp"]);
});
