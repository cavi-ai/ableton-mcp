import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyInstallPlan, buildInstallPlan } from "../src/artwork-packager.mjs";

test("builds a checksum-aware install plan and defaults to dry-run", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-packager-"));
  const stageRoot = join(directory, "stage");
  const targetRoot = join(directory, "target");
  mkdirSync(join(stageRoot, "serum 2"), { recursive: true });
  writeFileSync(join(stageRoot, "serum 2", "NKS2_software_tile.webp"), "tile");
  writeFileSync(join(stageRoot, "serum 2", "serum 2.meta"), "meta");
  const plan = buildInstallPlan({ stageRoot, targetRoot });
  assert.equal(plan.copies.length, 2);
  assert.equal(plan.errors.length, 0);
  assert.deepEqual(applyInstallPlan(plan), { applied: false, copied: 0, skipped: 0 });
  assert.equal(readFileSync(join(stageRoot, "serum 2", "serum 2.meta"), "utf8"), "meta");
});

test("applies copies, then skips checksum matches", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-packager-apply-"));
  const stageRoot = join(directory, "stage");
  const targetRoot = join(directory, "target");
  mkdirSync(join(stageRoot, "omnisphere"), { recursive: true });
  writeFileSync(join(stageRoot, "omnisphere", "VB_artwork.png"), "image");
  const first = buildInstallPlan({ stageRoot, targetRoot });
  assert.deepEqual(applyInstallPlan(first, { apply: true }), { applied: true, copied: 1, skipped: 0 });
  const second = buildInstallPlan({ stageRoot, targetRoot });
  assert.equal(second.copies.length, 0);
  assert.equal(second.skipped.length, 1);
});

test("rejects stage paths that escape the selected target root", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-packager-escape-"));
  assert.throws(
    () => buildInstallPlan({ stageRoot: join(directory, "missing"), targetRoot: join(directory, "target") }),
    /stage root does not exist/
  );
});
