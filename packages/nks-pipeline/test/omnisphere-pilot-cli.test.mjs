import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Omnisphere pilot CLI previews without writes and creates a non-overwriting packet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnisphere-pilot-cli-"));
  const manifestPath = join(directory, "manifest.json");
  const outputPath = join(directory, "pilot.json");
  const record = { id: "omnisphere:0123456789abcdef01234567", productSlug: "omnisphere",
    name: "Warm Pad", bank: "Factory", subBank: "Pads + Strings",
    sourceRelativePath: "Factory.db/Warm Pad.prt_omn", sourceContainerPath: "/factory/Factory.db",
    sourceEntryName: "Pads + Strings/Warm Pad.prt_omn", sourceFingerprint: "sha256:abc",
    state: "discovered" };
  await writeFile(manifestPath, JSON.stringify({ records: [record] }));
  const cli = new URL("../scripts/build-omnisphere-pilot.mjs", import.meta.url).pathname;
  const args = [cli, "--manifest", manifestPath, "--out", outputPath];
  assert.equal(JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" })).dryRun, true);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  const applied = JSON.parse(execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8" }));
  assert.equal(applied.dryRun, false);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).jobs[0].id, record.id);
  assert.throws(() => execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8", stdio: "pipe" }),
    /EEXIST/);
});
