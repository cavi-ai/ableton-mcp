import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { symbolSvg } from "../src/artwork-symbols.mjs";
import {
  renderBankArtwork,
  renderCategoryVariant,
  renderDerivatives
} from "../src/artwork-renderer.mjs";

function sourceFixture(directory) {
  const path = join(directory, "source.png");
  const result = spawnSync("magick", ["-size", "1254x1254", "gradient:#080b14-#334155", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return path;
}

test("renders deterministic bank and category artwork", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-renderer-"));
  const source = sourceFixture(directory);
  const bankA = join(directory, "bank-a.png");
  const bankB = join(directory, "bank-b.png");
  assert.equal(renderBankArtwork({ inputPath: source, outputPath: bankA, artworkId: "art:one" }).checksum, renderBankArtwork({ inputPath: source, outputPath: bankB, artworkId: "art:one" }).checksum);
  const variantA = join(directory, "variant-a.png");
  const variantB = join(directory, "variant-b.png");
  assert.equal(renderCategoryVariant({ inputPath: bankA, outputPath: variantA, symbol: "low-orbit", accent: "#8B5CF6" }).checksum, renderCategoryVariant({ inputPath: bankA, outputPath: variantB, symbol: "low-orbit", accent: "#8B5CF6" }).checksum);
  const sampled = spawnSync(
    "magick",
    [variantA, "-format", "%[pixel:p{1060,1060}]", "info:"],
    { encoding: "utf8" }
  );
  assert.equal(sampled.status, 0, sampled.stderr);
  assert.doesNotMatch(sampled.stdout, /255,255,255|1,1,1/);
});

test("rejects unknown symbols", () => {
  assert.throws(() => symbolSvg("unknown", "#ffffff"), /unknown artwork symbol/);
});

test("renders every configured derivative at exact dimensions", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-derivatives-"));
  const source = sourceFixture(directory);
  const policy = JSON.parse(readFileSync(new URL("../../../config/artwork/derivatives.json", import.meta.url), "utf8"));
  const results = renderDerivatives({ inputPath: source, outputRoot: join(directory, "out"), policy });
  assert.equal(results.length, 8);
  for (const result of results) assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
});
