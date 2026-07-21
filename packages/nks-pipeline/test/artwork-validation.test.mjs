import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validateArtwork } from "../src/artwork-validation.mjs";

function fixture(extension, geometry = "1024x1024", color = "#111827") {
  const directory = mkdtempSync(join(tmpdir(), "nks-artwork-validation-"));
  const path = join(directory, `fixture.${extension}`);
  const result = spawnSync("magick", ["-size", geometry, `xc:${color}`, path], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return path;
}

test("validates PNG format, dimensions, and checksum", () => {
  const result = validateArtwork(fixture("png"), {
    format: "PNG",
    minWidth: 1024,
    minHeight: 1024
  });
  assert.deepEqual(
    { format: result.format, width: result.width, height: result.height },
    { format: "PNG", width: 1024, height: 1024 }
  );
  assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
});

test("rejects missing, undersized, and non-PNG masters", () => {
  assert.throws(
    () => validateArtwork("/definitely/missing/master.png", { format: "PNG", minWidth: 1024, minHeight: 1024 }),
    /artwork file does not exist/
  );
  assert.throws(
    () => validateArtwork(fixture("png", "512x1024"), { format: "PNG", minWidth: 1024, minHeight: 1024 }),
    /artwork dimensions 512x1024 are below 1024x1024/
  );
  assert.throws(
    () => validateArtwork(fixture("jpg"), { format: "PNG", minWidth: 1024, minHeight: 1024 }),
    /artwork format JPEG does not match PNG/
  );
});

test("rejects unreadable image bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "nks-artwork-invalid-"));
  const path = join(directory, "broken.png");
  writeFileSync(path, "not an image");
  assert.throws(
    () => validateArtwork(path, { format: "PNG", minWidth: 1, minHeight: 1 }),
    /unable to identify artwork/
  );
});
