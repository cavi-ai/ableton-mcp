import test from "node:test";
import assert from "node:assert/strict";
import { buildSerumPilot } from "../src/serum-pilot.mjs";

function record(index, bank, category) {
  const id = `serum-2:${index.toString(16).padStart(24, "0")}`;
  return { id, productSlug: "serum-2", name: `${category} ${index}`,
    sourcePath: `/factory/${bank}/${category} ${index}.fxp`,
    sourceRelativePath: `${bank}/${category} ${index}.fxp`,
    sourceFingerprint: `sha256:${index}`, state: "discovered" };
}

test("Serum pilot selection is deterministic and covers endpoints, every bank, and representative categories", () => {
  const categories = ["Bass", "Lead", "Pad", "Synth", "FX", "Pluck", "Keys"];
  const records = Array.from({ length: 30 }, (_, index) =>
    record(index, `Bank ${index % 9}`, categories[index % categories.length]));
  const first = buildSerumPilot(records, { requestedSize: 25 });
  assert.deepEqual(first, buildSerumPilot([...records].reverse(), { requestedSize: 25 }));
  assert.equal(first.jobs.length, 25);
  assert.deepEqual(first.coverage.missingBanks, []);
  assert.deepEqual(first.coverage.missingCategories, []);
  assert.equal(first.coverage.first, true);
  assert.equal(first.coverage.last, true);
  assert.equal(first.jobs[0].sourceFingerprint.startsWith("sha256:"), true);
});

test("Serum pilot grows for bank coverage and excludes missing and User-source records", () => {
  const records = Array.from({ length: 27 }, (_, index) => record(index, `Bank ${index}`, "Synth"));
  records.push({ ...record(28, "User", "Bass"), sourceRelativePath: "User/Bass 28.fxp" });
  records.push({ ...record(29, "Other", "Lead"), missing: true });
  records.push({ ...record(30, "Other", "Pad"), productSlug: "omnisphere" });
  const pilot = buildSerumPilot(records, { requestedSize: 25 });
  assert.equal(pilot.actualSize, 27);
  assert.equal(pilot.adjustment.reason, "bank_coverage_requires_larger_pilot");
  assert.ok(pilot.jobs.every(({ sourceRelativePath }) => !sourceRelativePath.startsWith("User/")));
  assert.equal(pilot.jobs.some(({ sourceRelativePath }) => sourceRelativePath.startsWith("Other/")), false);
});

test("Serum pilot packets use collision-safe filenames and exact evidence queries", () => {
  const pilot = buildSerumPilot([{ ...record(1, "Bass", "Deep:Wide?"),
    sourceRelativePath: "Bass/Deep:Wide?.fxp", name: "Deep:Wide?" }], { requestedSize: 1 });
  assert.equal(pilot.jobs[0].nksName, "CAVI Serum2 - Bass - Deep-Wide- - 00000000");
  assert.deepEqual(pilot.jobs[0].evidenceQuery, {
    name: pilot.jobs[0].nksName, product: "Serum 2", fileName: `${pilot.jobs[0].nksName}.nksf`
  });
});
