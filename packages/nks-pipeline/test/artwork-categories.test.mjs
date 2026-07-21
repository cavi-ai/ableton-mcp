import test from "node:test";
import assert from "node:assert/strict";
import {
  loadCategoryConfig,
  normalizeArtworkCategory
} from "../src/artwork-categories.mjs";

const configUrl = new URL("../../../config/artwork/categories.json", import.meta.url);

test("loads the complete versioned artwork category taxonomy", () => {
  const config = loadCategoryConfig(configUrl);
  assert.equal(config.version, 1);
  assert.equal(config.categories.length, 15);
  assert.equal(new Set(config.categories.map(({ id }) => id)).size, 15);
  assert.equal(new Set(config.categories.map(({ symbol }) => symbol)).size, 15);
});

test("normalizes known aliases in priority order", () => {
  const config = loadCategoryConfig(configUrl);
  assert.equal(
    normalizeArtworkCategory(
      { types: ["Synth Bass"], modes: [], bank: "", subBank: "" },
      config
    ),
    "bass"
  );
  assert.equal(
    normalizeArtworkCategory(
      { types: ["Arpeggiated"], modes: [], bank: "", subBank: "" },
      config
    ),
    "arpeggio"
  );
});

test("uses modes and bank metadata when types do not match", () => {
  const config = loadCategoryConfig(configUrl);
  assert.equal(
    normalizeArtworkCategory(
      { types: [], modes: ["Rhythmic Sequence"], bank: "", subBank: "" },
      config
    ),
    "sequence"
  );
  assert.equal(
    normalizeArtworkCategory(
      { types: [], modes: [], bank: "Atmospheres", subBank: "Air" },
      config
    ),
    "atmosphere"
  );
});

test("preset names override broad sound-pack metadata", () => {
  const config = loadCategoryConfig(configUrl);
  assert.equal(
    normalizeArtworkCategory(
      {
        name: "LD - Heavenly Sines",
        types: ["Everything Bass"],
        modes: [],
        bank: "Factory",
        subBank: "Everything Bass"
      },
      config
    ),
    "lead"
  );
  assert.equal(
    normalizeArtworkCategory(
      { name: "PD Drifting in Air", types: [], modes: [], bank: "Factory", subBank: "" },
      config
    ),
    "pad"
  );
});

test("maps unmatched metadata to miscellaneous", () => {
  const config = loadCategoryConfig(configUrl);
  assert.equal(
    normalizeArtworkCategory(
      { types: ["Unmapped Thing"], modes: [], bank: "Odd", subBank: "" },
      config
    ),
    "miscellaneous"
  );
});

test("rejects incomplete or duplicate category configurations", () => {
  assert.throws(
    () => loadCategoryConfig(new URL("./fixtures/artwork-invalid-categories.json", import.meta.url)),
    /invalid artwork category config/
  );
});
