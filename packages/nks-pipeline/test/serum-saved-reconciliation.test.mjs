import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { Catalog } from "../src/catalog.mjs";
import { createPresetRecord } from "../src/domain.mjs";
import { ManifestStore } from "../src/manifest-store.mjs";
import { reconcileSerumSaved, serumNksName } from "../src/serum-saved-reconciliation.mjs";

const execFile = promisify(execFileCallback);

async function fixture({ indexedProduct = "Serum 2" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "serum-reconcile-"));
  const sourceRoot = join(directory, "sources");
  const sourcePath = join(sourceRoot, "ARTIST", "JACK U", "BA Gimme.fxp");
  const contentRoot = join(directory, "User Content");
  await mkdir(join(sourceRoot, "ARTIST", "JACK U"), { recursive: true });
  await mkdir(join(contentRoot, "Serum 2"), { recursive: true });
  await writeFile(sourcePath, "factory source");
  const sourceFingerprint = `sha256:${createHash("sha256").update("factory source").digest("hex")}`;
  const record = createPresetRecord({ productSlug: "serum-2", sourceRoot, sourcePath, name: "BA Gimme",
    bank: "Factory", subBank: "JACK U", types: [], modes: [], author: "Xfer Records", sourceFingerprint });
  const nksName = serumNksName(record);
  const nksPath = join(contentRoot, "Serum 2", `${nksName}.nksf`);
  await writeFile(nksPath, "komplete saved bytes");
  const manifestPath = join(directory, "manifest.json");
  const catalogPath = join(directory, "catalog.sqlite");
  const runLogPath = join(directory, "run.jsonl");
  const sourceLoadEvidencePath = join(directory, "source-load-observation.txt");
  const browserPath = join(directory, "komplete.db3");
  await writeFile(sourceLoadEvidencePath, "Serum loaded BA Gimme without missing-file warning");
  const manifest = await ManifestStore.open(manifestPath);
  await manifest.upsert(record);
  await manifest.flush();
  const catalog = Catalog.open(catalogPath);
  catalog.upsert(record);
  catalog.close();
  const browser = new DatabaseSync(browserPath);
  browser.exec(`CREATE TABLE v_sound_info (name TEXT, product TEXT, file_name TEXT, file_ext TEXT);
    CREATE TABLE k_content_path (path TEXT, visible INTEGER);`);
  browser.prepare("INSERT INTO k_content_path VALUES (?, 1)").run(contentRoot);
  browser.prepare("INSERT INTO v_sound_info VALUES (?, ?, ?, 'nksf')").run(nksName, indexedProduct, nksPath);
  browser.close();
  const run = { id: record.id, state: "nks_saved", sourcePath, expectedDisplayName: record.name,
    observedDisplayName: record.name, nksName, at: "2026-07-13T18:18:01Z",
    sourceLoad: { missingFiles: [], evidencePath: sourceLoadEvidencePath,
      evidenceSha256: createHash("sha256").update("Serum loaded BA Gimme without missing-file warning").digest("hex") } };
  await writeFile(runLogPath, `${JSON.stringify(run)}\n`);
  return { manifestPath, catalogPath, runLogPath, browserPath, userContentRoot: contentRoot,
    record, sourcePath, sourceLoadEvidencePath, run };
}

test("Serum reconciliation dry-runs, then advances only checksum- and index-backed saved state", async () => {
  const input = await fixture();
  const dry = await reconcileSerumSaved(input);
  assert.deepEqual(dry.plannedIds, [input.record.id]);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "discovered");
  const applied = await reconcileSerumSaved({ ...input, apply: true });
  assert.deepEqual(applied.updatedIds, [input.record.id]);
  const saved = (await ManifestStore.open(input.manifestPath)).get(input.record.id);
  assert.equal(saved.state, "nks_saved");
  assert.equal(saved.evidence.at(-1).artifact.sha256.length, 64);
  assert.deepEqual(saved.evidence.at(-1).sourceLoad.reportedMissingFiles, []);
  assert.equal(saved.evidence.at(-1).sourceLoad.evidence.sha256, input.run.sourceLoad.evidenceSha256);
  const catalog = Catalog.open(input.catalogPath);
  assert.equal(catalog.get(input.record.id).state, "nks_saved");
  catalog.close();
  const repeat = await reconcileSerumSaved({ ...input, apply: true });
  assert.deepEqual(repeat.updatedIds, []);
});

test("Serum reconciliation rejects changed sources and unmatched Komplete products without advancing", async () => {
  const stale = await fixture();
  await writeFile(stale.sourcePath, "changed source");
  await assert.rejects(() => reconcileSerumSaved({ ...stale, apply: true }), /source fingerprint changed/);
  assert.equal((await ManifestStore.open(stale.manifestPath)).get(stale.record.id).state, "discovered");
  const wrongProduct = await fixture({ indexedProduct: "Omnisphere" });
  await assert.rejects(() => reconcileSerumSaved({ ...wrongProduct, apply: true }), /not indexed/);
  assert.equal((await ManifestStore.open(wrongProduct.manifestPath)).get(wrongProduct.record.id).state, "discovered");
});

test("Serum reconciliation refuses an NKS save made with missing source assets", async () => {
  const input = await fixture();
  await writeFile(input.runLogPath, `${JSON.stringify({ ...input.run,
    sourceLoad: { ...input.run.sourceLoad, missingFiles: ["Alien Landscape_E3.wav"] } })}\n`);
  await assert.rejects(() => reconcileSerumSaved({ ...input, apply: true }), /missing source assets/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "discovered");
});

test("Serum reconciliation requires a current source-load observation", async () => {
  const missing = await fixture();
  await writeFile(missing.runLogPath, `${JSON.stringify({ ...missing.run, sourceLoad: undefined })}\n`);
  await assert.rejects(() => reconcileSerumSaved({ ...missing, apply: true }), /missing source assets/);
  const changed = await fixture();
  await writeFile(changed.sourceLoadEvidencePath, "changed observation");
  await assert.rejects(() => reconcileSerumSaved({ ...changed, apply: true }), /source-load observation checksum mismatch/);
  assert.equal((await ManifestStore.open(changed.manifestPath)).get(changed.record.id).state, "discovered");
});

test("Serum reconciliation CLI defaults to a non-mutating dry run", async () => {
  const input = await fixture();
  const script = new URL("../scripts/reconcile-serum-saved.mjs", import.meta.url).pathname;
  const { stdout } = await execFile(process.execPath, [script,
    "--manifest", input.manifestPath, "--catalog", input.catalogPath,
    "--run-log", input.runLogPath, "--browser-db", input.browserPath,
    "--user-content-root", input.userContentRoot]);
  assert.deepEqual(JSON.parse(stdout).plannedIds, [input.record.id]);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "discovered");
});
