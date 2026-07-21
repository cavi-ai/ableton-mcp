import test from "node:test";
import assert from "node:assert/strict";
import { calculateCompletion } from "../src/completion-report.mjs";

test("requires source, browser, NKS, and artwork completeness per product", () => {
  const result = calculateCompletion({
    productSlugs: ["serum-2", "vps-avenger"],
    manifestRecords: [
      { id: "serum:a", productSlug: "serum-2" },
      { id: "serum:b", productSlug: "serum-2" }
    ],
    sourceComplete: { "serum-2": true, "vps-avenger": false },
    browserInventories: { "serum-2": ["serum:a", "serum:b"] },
    nksValidIds: new Set(["serum:a", "serum:b"]),
    artworkAssignments: new Map([["serum:a", "art:a"], ["serum:b", "art:b"]]),
    approvedArtworkIds: new Set(["art:a", "art:b"])
  });
  assert.equal(result.products["serum-2"].fullyComplete, true);
  assert.equal(result.products["vps-avenger"].sourceComplete, false);
  assert.equal(result.products["vps-avenger"].browserComplete, false);
  assert.equal(result.combined.fullyComplete, false);
  assert.equal(result.products["vps-avenger"].blockers.includes("AVENGER_BROWSER_INVENTORY_MISSING"), true);
});

test("one missing NKS or artwork assignment keeps completion false", () => {
  const result = calculateCompletion({
    productSlugs: ["omnisphere"],
    manifestRecords: [
      { id: "omni:a", productSlug: "omnisphere" },
      { id: "omni:b", productSlug: "omnisphere" }
    ],
    sourceComplete: { omnisphere: true },
    browserInventories: { omnisphere: ["omni:a", "omni:b"] },
    nksValidIds: new Set(["omni:a"]),
    artworkAssignments: new Map([["omni:a", "art:a"]]),
    approvedArtworkIds: new Set(["art:a"])
  });
  assert.equal(result.products.omnisphere.nksComplete, false);
  assert.equal(result.products.omnisphere.artworkComplete, false);
  assert.deepEqual(result.products.omnisphere.blockers, [
    "NKS_RECORDS_INCOMPLETE",
    "ARTWORK_ASSIGNMENTS_INCOMPLETE"
  ]);
});
