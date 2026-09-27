import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KompleteBrowser } from "../src/komplete-browser.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "komplete-index-"));
  const path = join(directory, "komplete.db3");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE v_sound_info (name TEXT, product TEXT, file_name TEXT, file_ext TEXT);
    CREATE TABLE k_content_path (path TEXT, visible INTEGER);
    INSERT INTO k_content_path VALUES ('/content', 1);
    INSERT INTO v_sound_info VALUES ('Bass A', 'Serum 2', '/content/Serum 2/Bass A.nksf', 'nksf');`);
  db.close();
  return path;
}

test("Komplete index requires exact product, file, extension and visible user root", async () => {
  const browser = KompleteBrowser.open(await fixture());
  const query = { name: "Bass A", product: "Serum 2", fileName: "Bass A.nksf", userContentRoot: "/content" };
  assert.deepEqual(browser.findSavedPreset(query), {
    name: "Bass A", product: "Serum 2", fileName: "/content/Serum 2/Bass A.nksf", fileExt: "nksf"
  });
  assert.equal(browser.findSavedPreset({ ...query, product: "Omnisphere" }), undefined);
  assert.equal(browser.findSavedPreset({ ...query, fileName: "Other.nksf" }), undefined);
  assert.equal(browser.findSavedPreset({ ...query, userContentRoot: "/other" }), undefined);
  assert.equal(browser.findSavedPreset({ ...query, fileName: "Bass A.nks" }), undefined);
  browser.close();
});

test("Komplete index rejects ambiguous duplicate rows and paths outside content root", async () => {
  const path = await fixture();
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO v_sound_info VALUES ('Bass A', 'Serum 2', '/other/Bass A.nksf', 'nksf');`);
  db.close();
  const browser = KompleteBrowser.open(path);
  const query = { name: "Bass A", product: "Serum 2", fileName: "Bass A.nksf", userContentRoot: "/content" };
  assert.equal(browser.findSavedPreset(query)?.fileName, "/content/Serum 2/Bass A.nksf");
  browser.close();
  const db2 = new DatabaseSync(path);
  db2.exec(`INSERT INTO v_sound_info VALUES ('Bass A', 'Serum 2', '/content/Alternate/Bass A.nksf', 'nksf');`);
  db2.close();
  const ambiguous = KompleteBrowser.open(path);
  assert.throws(() => ambiguous.findSavedPreset(query), /ambiguous/);
  ambiguous.close();
});
