import test from "node:test";
import assert from "node:assert/strict";
import { createPresetRecord, stablePresetId, transitionPreset } from "../src/domain.mjs";

const discovery = {
  productSlug: "serum-2",
  sourceRoot: "/vendor/Serum Presets/Presets",
  sourcePath: "/vendor/Serum Presets/Presets/Bass/Deep.fxp",
  name: "Deep",
  bank: "Factory",
  subBank: "Bass",
  types: ["Bass"],
  modes: [],
  author: "Xfer Records",
  sourceFingerprint: "sha256:abc"
};

test("stablePresetId ignores the absolute source root", () => {
  const moved = { ...discovery, sourceRoot: "/other", sourcePath: "/other/Bass/Deep.fxp" };
  assert.equal(stablePresetId(discovery), stablePresetId(moved));
});

test("createPresetRecord starts a factory preset in discovered state", () => {
  const record = createPresetRecord(discovery);
  assert.equal(record.state, "discovered");
  assert.equal(record.attempts, 0);
  assert.equal(record.productSlug, "serum-2");
  assert.equal(record.sourceRelativePath, "Bass/Deep.fxp");
});

test("transitionPreset rejects skipped states", () => {
  const record = createPresetRecord(discovery);
  assert.throws(() => transitionPreset(record, "nks_saved"), /discovered -> nks_saved/);
});

test("transitionPreset records the generation evidence timestamp", () => {
  const record = transitionPreset(createPresetRecord(discovery), "loading", {
    at: "2026-07-13T12:00:00.000Z",
    workerId: "worker-1"
  });
  assert.equal(record.state, "loading");
  assert.equal(record.evidence.at(-1).at, "2026-07-13T12:00:00.000Z");
});

test("transitionPreset permits quarantine from any nonterminal state", () => {
  const record = transitionPreset(createPresetRecord(discovery), "quarantined", { reason: "load_failed" });
  assert.equal(record.state, "quarantined");
  assert.equal(record.evidence.at(-1).reason, "load_failed");
});
