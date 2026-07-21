import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildContactSheet } from "../src/artwork-contact-sheet.mjs";
import { validateArtwork } from "../src/artwork-validation.mjs";

test("builds a font-free contact sheet with exact grid dimensions", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-contact-sheet-"));
  const inputs = ["#111827", "#1e293b", "#334155"].map((color, index) => {
    const path = join(directory, `${index}.png`);
    const result = spawnSync("magick", ["-size", "200x200", `xc:${color}`, path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return path;
  });
  const outputPath = join(directory, "sheet.png");
  buildContactSheet(inputs, outputPath, {
    columns: 2,
    tileWidth: 100,
    tileHeight: 100,
    gap: 8,
    background: "#080b14"
  });
  const result = validateArtwork(outputPath, { format: "PNG", minWidth: 216, minHeight: 216 });
  assert.equal(result.width, 216);
  assert.equal(result.height, 216);
});
