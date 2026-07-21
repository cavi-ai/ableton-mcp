import test from "node:test";
import assert from "node:assert/strict";
import {
  createArtworkRecord,
  stableArtworkId,
  transitionArtwork
} from "../src/artwork-domain.mjs";

const tuple = {
  productSlug: "serum-2",
  library: "Factory",
  bank: "Bass",
  subBank: "",
  category: "bass"
};

test("stable artwork IDs ignore object key order", () => {
  assert.equal(
    stableArtworkId(tuple, "variant"),
    stableArtworkId(
      {
        category: "bass",
        bank: "Bass",
        library: "Factory",
        subBank: "",
        productSlug: "serum-2"
      },
      "variant"
    )
  );
});

test("stable artwork IDs distinguish hierarchy levels", () => {
  assert.notEqual(stableArtworkId(tuple, "bank"), stableArtworkId(tuple, "variant"));
});

test("artwork records begin planned and are immutable", () => {
  const record = createArtworkRecord({ ...tuple, level: "variant", promptVersion: 1 });
  assert.equal(record.state, "planned");
  assert.equal(record.id, stableArtworkId(tuple, "variant"));
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.evidence), true);
});

test("transitions follow the approved lifecycle", () => {
  const planned = createArtworkRecord({ ...tuple, level: "variant", promptVersion: 1 });
  const generated = transitionArtwork(planned, "generated", { path: "variant.png" });
  const validated = transitionArtwork(generated, "validated", { checksum: "abc" });
  const approved = transitionArtwork(validated, "approved", { reviewer: "operator" });
  assert.equal(approved.state, "approved");
  assert.deepEqual(approved.evidence.map(({ state }) => state), ["generated", "validated", "approved"]);
});

test("rejects skipped lifecycle states and terminal rewrites", () => {
  const planned = createArtworkRecord({ ...tuple, level: "variant", promptVersion: 1 });
  assert.throws(() => transitionArtwork(planned, "approved"), /invalid artwork transition/);
  const rejected = transitionArtwork(planned, "rejected", { reason: "text detected" });
  assert.throws(() => transitionArtwork(rejected, "generated"), /invalid artwork transition/);
});
