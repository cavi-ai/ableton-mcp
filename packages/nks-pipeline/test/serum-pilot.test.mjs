import test from "node:test";
import assert from "node:assert/strict";
import { buildSerumPilot, serumNksName } from "../src/serum-pilot.mjs";

function record(index, bank, category) {
  const hex = index.toString(16).padStart(24, "0");
  return {
    id: `serum-2:${hex}`,
    productSlug: "serum-2",
    sourcePath: `/factory/${bank}/${category} ${index}.fxp`,
    sourceRelativePath: `${bank}/${category} ${index}.fxp`,
    name: `${category} ${index}`
  };
}

test("buildSerumPilot deterministically covers endpoints, banks, and sound categories", () => {
  const categories = ["Bass", "Lead", "Pad", "Synth", "FX", "Pluck", "Keys"];
  const records = Array.from({ length: 30 }, (_, index) =>
    record(index, `Bank ${index % 9}`, categories[index % categories.length])
  ).reverse();
  const first = buildSerumPilot(records, { requestedSize: 25 });
  const second = buildSerumPilot([...records].reverse(), { requestedSize: 25 });
  assert.deepEqual(first, second);
  assert.equal(first.jobs.length, 25);
  assert.equal(first.coverage.first, true);
  assert.equal(first.coverage.last, true);
  assert.deepEqual(first.coverage.missingBanks, []);
  assert.deepEqual(first.coverage.missingCategories, []);
});

test("buildSerumPilot expands above 25 when bank coverage requires it", () => {
  const records = Array.from({ length: 27 }, (_, index) => record(index, `Bank ${index}`, "Synth"));
  const pilot = buildSerumPilot(records, { requestedSize: 25 });
  assert.equal(pilot.jobs.length, 27);
  assert.equal(pilot.adjustment.reason, "bank_coverage_requires_larger_pilot");
});

test("serumNksName is collision-safe and filesystem-safe", () => {
  const value = serumNksName({
    id: "serum-2:0123456789abcdef01234567",
    sourceRelativePath: "Bass/Deep:Wide?.fxp"
  });
  assert.equal(value, "CAVI Serum2 - Bass - Deep-Wide- - 01234567");
});
