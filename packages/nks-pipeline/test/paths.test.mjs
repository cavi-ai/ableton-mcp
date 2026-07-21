import test from "node:test";
import assert from "node:assert/strict";
import { planArtifactPaths } from "../src/paths.mjs";

const record = {
  productSlug: "serum-2",
  bank: "Factory",
  subBank: "Bass",
  name: "Deep / Wide",
  id: "serum-2:abc"
};

test("planArtifactPaths keeps outputs inside the configured root", () => {
  const plan = planArtifactPaths(record, "/output");
  assert.match(plan.nksPath, /^\/output\/User Content\/Serum 2\//);
  assert.match(plan.previewPath, /^\/output\/Previews\/Serum 2\//);
  assert.equal(plan.nksPath.includes(".."), false);
});
