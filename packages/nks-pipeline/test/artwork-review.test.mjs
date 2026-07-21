import test from "node:test";
import assert from "node:assert/strict";
import { createArtworkRecord, transitionArtwork } from "../src/artwork-domain.mjs";
import { approveArtworkSelection } from "../src/artwork-review.mjs";

function validated(idSuffix, bank = "Essential") {
  const planned = createArtworkRecord({
    productSlug: "serum-2",
    library: "POP",
    bank: "Factory",
    subBank: bank,
    category: idSuffix,
    level: "variant",
    promptVersion: 1
  });
  return transitionArtwork(
    transitionArtwork(planned, "generated", { path: `${idSuffix}.png` }),
    "validated",
    { checksum: `sha256:${idSuffix}` }
  );
}

test("approves only validated artwork matching the selection", () => {
  const matching = validated("bass");
  const other = validated("lead", "Other");
  const result = approveArtworkSelection([matching, other], {
    productSlug: "serum-2",
    bank: "Essential",
    reviewer: "operator"
  });
  assert.equal(result.records.find(({ id }) => id === matching.id).state, "approved");
  assert.equal(result.records.find(({ id }) => id === other.id).state, "validated");
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].decision, "approved");
});
