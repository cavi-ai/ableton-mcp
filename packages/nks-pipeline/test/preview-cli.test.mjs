import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("preview CLI plans without writing and applies explicit captured-audio processing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nks-preview-cli-"));
  const rawPath = join(directory, "raw.wav");
  const finalPath = join(directory, "preview.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000:duration=12", "-c:a", "pcm_s24le", rawPath]);
  const cli = new URL("../scripts/process-preview.mjs", import.meta.url).pathname;
  const dry = JSON.parse(execFileSync(process.execPath,
    [cli, "--raw", rawPath, "--out", finalPath], { encoding: "utf8" }));
  assert.equal(dry.dryRun, true);
  await assert.rejects(stat(finalPath), { code: "ENOENT" });
  const applied = JSON.parse(execFileSync(process.execPath,
    [cli, "--raw", rawPath, "--out", finalPath, "--apply"], { encoding: "utf8" }));
  assert.equal(applied.dryRun, false);
  assert.equal(applied.measurement.sampleRate, 48000);
  assert.match(applied.sha256, /^[0-9a-f]{64}$/);
  assert.ok((await stat(finalPath)).size > 0);
});
