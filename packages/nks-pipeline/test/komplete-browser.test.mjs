import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KompleteBrowser } from "../src/komplete-browser.mjs";

async function fixtureDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "komplete-browser-"));
  const path = join(dir, "komplete.db3");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE v_sound_info (name TEXT, product TEXT, file_name TEXT, file_ext TEXT);
    CREATE TABLE k_content_path (path TEXT, visible INTEGER);
    INSERT INTO k_content_path VALUES ('/Users/test/Documents/Native Instruments/User Content', 1);
    INSERT INTO v_sound_info VALUES (
      'CAVI Bass Deep abc123',
      'Serum 2',
      '/Users/test/Documents/Native Instruments/User Content/Serum 2/CAVI Bass Deep abc123.nksf',
      'nksf'
    );
  `);
  database.close();
  return path;
}

test("KompleteBrowser confirms an exact indexed NKS preset inside configured content", async () => {
  const browser = KompleteBrowser.open(await fixtureDatabase());
  const match = browser.findSavedPreset({
    name: "CAVI Bass Deep abc123",
    product: "Serum 2",
    fileName: "CAVI Bass Deep abc123.nksf",
    userContentRoot: "/Users/test/Documents/Native Instruments/User Content"
  });
  assert.equal(match.fileExt, "nksf");
  assert.equal(match.fileName.endsWith("/Serum 2/CAVI Bass Deep abc123.nksf"), true);
  browser.close();
});

test("KompleteBrowser rejects product, filename, extension, and content-root mismatches", async () => {
  const browser = KompleteBrowser.open(await fixtureDatabase());
  const base = {
    name: "CAVI Bass Deep abc123",
    product: "Serum 2",
    fileName: "CAVI Bass Deep abc123.nksf",
    userContentRoot: "/Users/test/Documents/Native Instruments/User Content"
  };
  assert.equal(browser.findSavedPreset({ ...base, product: "Omnisphere" }), undefined);
  assert.equal(browser.findSavedPreset({ ...base, fileName: "Other.nksf" }), undefined);
  assert.equal(browser.findSavedPreset({ ...base, fileName: "CAVI Bass Deep abc123.nks" }), undefined);
  assert.equal(browser.findSavedPreset({ ...base, userContentRoot: "/tmp/User Content" }), undefined);
  browser.close();
});
