import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPreview, validatePreviewMeasurement } from "../src/preview-runner.mjs";

function tone(path, duration) {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    `sine=frequency=440:sample_rate=48000:duration=${duration}`,
    "-c:a", "pcm_s24le", path]);
}

test("real ffmpeg preview processing normalizes a 12-second capture and returns measured evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nks-preview-"));
  const rawPath = join(directory, "raw.wav");
  const finalPath = join(directory, "preview.wav");
  tone(rawPath, 12);
  const result = await runPreview({ rawPath, finalPath });
  assert.equal(result.finalPath, finalPath);
  assert.equal(result.measurement.sampleRate, 48000);
  assert.equal(result.measurement.bitDepth, 24);
  assert.ok(Math.abs(result.measurement.durationSeconds - 12) <= 0.1);
  assert.ok(Math.abs(result.measurement.integratedLufs + 16) <= 0.5);
  assert.ok(result.measurement.truePeakDbtp <= -1);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.ok((await stat(finalPath)).size > 0);
});

test("preview processing rejects a wrong-length capture without publishing an output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nks-preview-"));
  const rawPath = join(directory, "raw.wav");
  const finalPath = join(directory, "preview.wav");
  tone(rawPath, 1);
  await assert.rejects(runPreview({ rawPath, finalPath }), /duration_not_12_seconds/);
  await assert.rejects(readFile(finalPath), { code: "ENOENT" });
});

test("preview policy rejects missing or nonfinite measurements", () => {
  assert.deepEqual(validatePreviewMeasurement({ durationSeconds: NaN, sampleRate: 48000,
    bitDepth: 24, integratedLufs: -16, truePeakDbtp: -1.5 }).findings,
  ["invalid_duration"]);
});
