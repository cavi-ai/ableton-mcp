import test from "node:test";
import assert from "node:assert/strict";
import { loadCategoryConfig } from "../src/artwork-categories.mjs";
import { buildArtworkMatrix } from "../src/artwork-matrix.mjs";

const categoryConfig = loadCategoryConfig(
  new URL("../../../config/artwork/categories.json", import.meta.url)
);

function preset(id, overrides = {}) {
  return {
    id,
    productSlug: "serum-2",
    sourceRelativePath: "Bass/Deep.fxp",
    bank: "Bass",
    subBank: "Factory",
    types: ["Synth Bass"],
    modes: [],
    ...overrides
  };
}

test("deduplicates shared product, bank, and category artwork", () => {
  const matrix = buildArtworkMatrix([preset("preset:2"), preset("preset:1")], {
    categoryConfig,
    promptVersion: 1
  });
  assert.equal(matrix.assignments.length, 2);
  assert.equal(matrix.records.filter(({ level }) => level === "product").length, 1);
  assert.equal(matrix.records.filter(({ level }) => level === "bank").length, 1);
  assert.equal(matrix.records.filter(({ level }) => level === "variant").length, 1);
  assert.equal(matrix.assignments[0].presetId, "preset:1");
  assert.equal(matrix.assignments[0].artworkId, matrix.assignments[1].artworkId);
});

test("different normalized categories receive distinct variants", () => {
  const matrix = buildArtworkMatrix(
    [preset("preset:bass"), preset("preset:lead", { types: ["Synth Lead"] })],
    { categoryConfig, promptVersion: 1 }
  );
  assert.notEqual(matrix.assignments[0].artworkId, matrix.assignments[1].artworkId);
  assert.equal(matrix.records.filter(({ level }) => level === "variant").length, 2);
});

test("derives a library from the first relative path segment", () => {
  const matrix = buildArtworkMatrix(
    [preset("preset:one", { sourceRelativePath: "Factory Library/Bass/Deep.fxp" })],
    { categoryConfig, promptVersion: 1 }
  );
  assert.equal(matrix.records.find(({ level }) => level === "variant").library, "Factory Library");
});

test("rejects duplicate preset IDs and missing identities", () => {
  assert.throws(
    () => buildArtworkMatrix([preset("same"), preset("same")], { categoryConfig, promptVersion: 1 }),
    /duplicate preset same/
  );
  assert.throws(
    () => buildArtworkMatrix([{ ...preset(""), id: "" }], { categoryConfig, promptVersion: 1 }),
    /preset id is required/
  );
});

test("output ordering is deterministic", () => {
  const records = [preset("preset:z"), preset("preset:a", { types: ["Pad"] })];
  const left = buildArtworkMatrix(records, { categoryConfig, promptVersion: 1 });
  const right = buildArtworkMatrix([...records].reverse(), { categoryConfig, promptVersion: 1 });
  assert.deepEqual(left, right);
});

test("seeds configured product masters before presets are discoverable", () => {
  const matrix = buildArtworkMatrix([], {
    categoryConfig,
    promptVersion: 1,
    productConfig: {
      products: {
        "vps-avenger": { identity: "Mechanical" }
      }
    }
  });
  assert.equal(matrix.records.length, 1);
  assert.equal(matrix.records[0].productSlug, "vps-avenger");
  assert.equal(matrix.records[0].level, "product");
  assert.deepEqual(matrix.assignments, []);
});
