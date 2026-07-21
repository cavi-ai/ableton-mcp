import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planPreviewCommands, runPreview } from "../src/preview-runner.mjs";

const validMeasurement = {
  durationSeconds: 12,
  sampleRate: 48000,
  bitDepth: 24,
  integratedLufs: -16,
  truePeakDbtp: -1.2
};

test("planPreviewCommands renders and normalizes to the approved format", () => {
  const plan = planPreviewCommands({
    liveSetPath: "/work/preview.als",
    rawPath: "/tmp/raw.wav",
    normalizedPath: "/tmp/final.tmp.wav"
  });
  assert.deepEqual(plan.render.slice(0, 3), ["ableton-live", "--headless", "/work/preview.als"]);
  assert.equal(plan.normalize.includes("loudnorm=I=-16:TP=-1:LRA=11"), true);
  assert.equal(plan.normalize.includes("pcm_s24le"), true);
  assert.equal(plan.normalize.includes("48000"), true);
});

test("runPreview rejects a timed-out renderer", async () => {
  await assert.rejects(
    runPreview({
      render: () => new Promise(() => {}),
      measure: async () => validMeasurement,
      normalize: async () => {},
      rawPath: "/tmp/raw.wav",
      finalPath: "/tmp/final.wav",
      timeoutMs: 5
    }),
    /preview render timed out/
  );
});

test("runPreview rejects invalid audio before finalization", async () => {
  await assert.rejects(
    runPreview({
      render: async () => {},
      measure: async () => ({ ...validMeasurement, integratedLufs: -61 }),
      normalize: async () => {},
      rawPath: "/tmp/raw.wav",
      finalPath: "/tmp/final.wav"
    }),
    /silence/
  );
});

test("runPreview atomically finalizes a validated normalized preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nks-preview-"));
  const rawPath = join(dir, "raw.wav");
  const finalPath = join(dir, "preview.wav");
  const result = await runPreview({
    render: async () => writeFile(rawPath, "raw"),
    normalize: async (_raw, temporaryPath) => writeFile(temporaryPath, "normalized"),
    measure: async () => validMeasurement,
    rawPath,
    finalPath
  });
  assert.equal(await readFile(finalPath, "utf8"), "normalized");
  assert.equal(result.measurement.integratedLufs, -16);
});
