import test from "node:test";
import assert from "node:assert/strict";
import { buildOmnispherePilot, omnisphereNksName } from "../src/omnisphere-pilot.mjs";

function record(index, bank) {
  const hex = index.toString(16).padStart(24, "0");
  return {
    id: `omnisphere:${hex}`,
    productSlug: "omnisphere",
    bank,
    name: `Patch ${index}`,
    sourceContainerPath: `/factory/${bank}.db`,
    sourceEntryName: `Category ${index % 4}/Patch ${index}.prt_omn`
  };
}

test("buildOmnispherePilot deterministically covers every factory library", () => {
  const records = Array.from({ length: 40 }, (_, index) => record(index, `Library ${index % 5}`)).reverse();
  const first = buildOmnispherePilot(records, { size: 25 });
  const second = buildOmnispherePilot([...records].reverse(), { size: 25 });
  assert.deepEqual(first, second);
  assert.equal(first.jobs.length, 25);
  assert.deepEqual(first.coverage.missingBanks, []);
  assert.equal(first.coverage.first, true);
  assert.equal(first.coverage.last, true);
});

test("omnisphereNksName contains source identity and stable suffix", () => {
  assert.equal(
    omnisphereNksName(record(1, "Hardware Library")),
    "CAVI Omnisphere - Hardware Library - Category 1 - Patch 1 - 00000000"
  );
});
