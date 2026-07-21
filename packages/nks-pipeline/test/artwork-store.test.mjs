import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadArtworkStore,
  mergeArtworkRecords,
  saveArtworkStore
} from "../src/artwork-store.mjs";

const approvedRecord = Object.freeze({
  id: "art:approved",
  promptVersion: 1,
  state: "approved",
  checksum: "original"
});

test("approved records cannot be replaced at the same prompt version", () => {
  const merged = mergeArtworkRecords(
    [approvedRecord],
    [{ ...approvedRecord, checksum: "changed" }]
  );
  assert.equal(merged[0].checksum, "original");
});

test("a new prompt version permits replacement", () => {
  const merged = mergeArtworkRecords(
    [approvedRecord],
    [{ ...approvedRecord, promptVersion: 2, state: "planned", checksum: undefined }]
  );
  assert.equal(merged[0].promptVersion, 2);
  assert.equal(merged[0].state, "planned");
});

test("store persistence is stable and round trips", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-artwork-store-"));
  const path = join(directory, "matrix.json");
  const store = {
    version: 1,
    promptVersion: 1,
    records: [{ id: "art:b" }, { id: "art:a" }],
    assignments: [
      { presetId: "preset:b", artworkId: "art:b" },
      { presetId: "preset:a", artworkId: "art:a" }
    ]
  };
  saveArtworkStore(path, store);
  assert.deepEqual(loadArtworkStore(path), {
    ...store,
    records: [{ id: "art:a" }, { id: "art:b" }],
    assignments: [
      { presetId: "preset:a", artworkId: "art:a" },
      { presetId: "preset:b", artworkId: "art:b" }
    ]
  });
  assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
});

test("missing stores load as an empty versioned checkpoint", () => {
  const path = join(tmpdir(), `missing-artwork-${process.pid}-${Date.now()}.json`);
  assert.deepEqual(loadArtworkStore(path, { promptVersion: 3 }), {
    version: 1,
    promptVersion: 3,
    records: [],
    assignments: []
  });
});
