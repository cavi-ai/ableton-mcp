import test from "node:test";
import assert from "node:assert/strict";
import { buildOmnispherePilot } from "../src/omnisphere-pilot.mjs";

function record(index, bank, category) {
  const name = `Preset ${String(index).padStart(2, "0")}`;
  const sourceEntryName = `${category}/${name}.prt_omn`;
  return { id: `omnisphere:${index.toString(16).padStart(24, "0")}`,
    productSlug: "omnisphere", name, bank, subBank: category,
    sourceRelativePath: `${bank}.db/${name}.prt_omn`,
    sourceContainerPath: `/factory/${bank}.db`, sourceEntryName,
    sourceFingerprint: `sha256:${index}`, state: "discovered" };
}

test("Omnisphere pilot deterministically covers bank endpoints and top-level categories", () => {
  const categories = ["Synth Bass", "Pads + Strings", "ARP + BPM", "Human Voices", "Keyboards"];
  const records = Array.from({ length: 40 }, (_, index) =>
    record(index, `Library ${index % 4}`, `${categories[index % categories.length]}/Variant`));
  const pilot = buildOmnispherePilot(records, { requestedSize: 25 });
  assert.deepEqual(pilot, buildOmnispherePilot([...records].reverse(), { requestedSize: 25 }));
  assert.equal(pilot.actualSize, 25);
  assert.deepEqual(pilot.coverage.missingBanks, []);
  assert.deepEqual(pilot.coverage.missingCategories, []);
  assert.equal(pilot.coverage.first, true);
  assert.equal(pilot.coverage.last, true);
  assert.equal(pilot.jobs.every(job => job.browserPath.method === "plugin_browser"), true);
  assert.equal(pilot.jobs.every(job => job.sourceFingerprint.startsWith("sha256:")), true);
});

test("Omnisphere pilot expands for category coverage and excludes User and missing sources", () => {
  const records = Array.from({ length: 27 }, (_, index) => record(index, "Factory", `Category ${index}`));
  records.push({ ...record(27, "Factory", "User/Personal"), sourceEntryName: "User/Personal.prt_omn" });
  records.push({ ...record(28, "Factory", "Other"), missing: true });
  records.push({ ...record(29, "Factory", "Other"), productSlug: "serum-2" });
  const pilot = buildOmnispherePilot(records);
  assert.equal(pilot.actualSize, 27);
  assert.equal(pilot.adjustment.reason, "category_or_bank_coverage_requires_larger_pilot");
  assert.equal(pilot.jobs.some(job => job.sourceEntryName.includes("User/")), false);
  assert.equal(pilot.jobs.some(job => job.sourceEntryName.includes("Other/")), false);
});

test("Omnisphere pilot binds plugin-browser identity and collision-safe NKS names", () => {
  const preset = { ...record(1, "Moog:Tribute", "Synth Bass/Analog"),
    name: "Deep:Wide?", sourceEntryName: "Synth Bass/Analog/Deep:Wide?.prt_omn" };
  const pilot = buildOmnispherePilot([preset], { requestedSize: 1 });
  const job = pilot.jobs[0];
  assert.deepEqual(job.browserPath, { method: "plugin_browser", bank: "Moog:Tribute",
    categoryPath: ["Synth Bass", "Analog"], presetName: "Deep:Wide?" });
  assert.equal(job.sourceContainerPath, preset.sourceContainerPath);
  assert.equal(job.sourceEntryName, preset.sourceEntryName);
  assert.match(job.nksName, /^CAVI Omnisphere - Moog-Tribute - Synth Bass - Analog - Deep-Wide- - [0-9a-f]{12}$/);
  assert.deepEqual(job.evidenceQuery, { name: job.nksName, product: "Omnisphere",
    fileName: `${job.nksName}.nksf` });
});
