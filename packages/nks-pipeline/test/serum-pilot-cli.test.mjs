import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Serum pilot CLI plans first and writes a non-overwriting job packet only on apply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serum-pilot-cli-"));
  const manifestPath = join(directory, "manifest.json");
  const outputPath = join(directory, "pilot.json");
  const record = { id: "serum-2:0123456789abcdef01234567", productSlug: "serum-2",
    name: "Bass 1", sourcePath: "/factory/Bass/Bass 1.fxp",
    sourceRelativePath: "Bass/Bass 1.fxp", sourceFingerprint: "sha256:abc", state: "discovered" };
  await writeFile(manifestPath, JSON.stringify({ records: [record] }));
  const cli = new URL("../scripts/build-serum-pilot.mjs", import.meta.url).pathname;
  const args = [cli, "--manifest", manifestPath, "--out", outputPath];
  assert.equal(JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" })).dryRun, true);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  const applied = JSON.parse(execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8" }));
  assert.equal(applied.dryRun, false);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).jobs[0].id, record.id);
  assert.throws(() => execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8", stdio: "pipe" }),
    /EEXIST/);
});
