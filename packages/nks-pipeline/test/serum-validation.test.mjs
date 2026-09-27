import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "../src/catalog.mjs";
import { ManifestStore } from "../src/manifest-store.mjs";
import { runPreview } from "../src/preview-runner.mjs";
import { serumNksName } from "../src/serum-nks-name.mjs";
import { reconcileSerumValidation } from "../src/serum-validation.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "serum-validation-"));
  const sourcePath = join(directory, "preset.fxp");
  const nksPath = join(directory, "preset.nksf");
  const rawPath = join(directory, "raw.wav");
  const previewPath = join(directory, "preview.wav");
  const recallPath = join(directory, "recall-evidence.txt");
  const controllerPath = join(directory, "controller-evidence.txt");
  const reportPath = join(directory, "validation.json");
  const manifestPath = join(directory, "manifest.json");
  const catalogPath = join(directory, "catalog.sqlite");
  await writeFile(sourcePath, "factory preset bytes");
  await writeFile(nksPath, "Komplete Save As bytes");
  await writeFile(recallPath, "reported recall observation");
  await writeFile(controllerPath, "reported S88 mapping observation");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000:duration=12", "-c:a", "pcm_s24le", rawPath]);
  const preview = await runPreview({ rawPath, finalPath: previewPath });
  const record = { id: "serum-2:fixture", productSlug: "serum-2", name: "Preset",
    sourcePath, sourceRelativePath: "Factory/Bass/Preset.fxp", bank: "Factory", subBank: "Bass",
    author: "Xfer", sourceFingerprint: `sha256:${sha256("factory preset bytes")}`,
    state: "previewed", evidence: [
      { state: "nks_saved", kind: "komplete_index_and_file_verified",
        artifact: { path: nksPath, sha256: sha256("Komplete Save As bytes") } },
      { state: "previewed", kind: "reported_capture_and_measured_audio",
        artifact: { path: previewPath, sha256: preview.sha256 } }
    ] };
  const store = await ManifestStore.open(manifestPath);
  await store.upsert(record);
  await store.flush();
  const catalog = Catalog.open(catalogPath);
  catalog.upsert(record);
  catalog.close();
  const report = { format: "cavi-serum-validation-v1", presetId: record.id,
    sourceFingerprint: record.sourceFingerprint, nksSha256: sha256("Komplete Save As bytes"),
    previewSha256: preview.sha256,
    recall: { observedNksName: serumNksName(record), observedProduct: "Serum 2",
      evidencePath: recallPath, evidenceSha256: sha256("reported recall observation") },
    controller: { model: "Komplete Kontrol S88 MK3", evidencePath: controllerPath,
      evidenceSha256: sha256("reported S88 mapping observation"), pages: [
        { name: "Main", controls: ["Cutoff", "Resonance", "Attack", "Decay"].map(name => ({ name, displayValue: "50%" })) },
        { name: "Page 2", controls: ["Sustain", "Release", "Drive", "Volume"].map(name => ({ name, displayValue: "50%" })) }
      ] } };
  await writeFile(reportPath, JSON.stringify(report));
  return { manifestPath, catalogPath, reportPath, record, report, nksPath, previewPath };
}

test("Serum validation dry-runs then records checksum-bound recall and eight controller mappings", async () => {
  const input = await fixture();
  const args = { manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, reportPath: input.reportPath };
  assert.equal((await reconcileSerumValidation(args)).dryRun, true);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "previewed");
  assert.equal((await reconcileSerumValidation({ ...args, apply: true })).updated, true);
  const validated = (await ManifestStore.open(input.manifestPath)).get(input.record.id);
  assert.equal(validated.state, "validated");
  assert.equal(validated.evidence.at(-1).kind, "operator_reported_recall_controller_verified");
  assert.equal(validated.evidence.at(-1).controllerControlCount, 8);
  const catalog = Catalog.open(input.catalogPath);
  assert.equal(catalog.get(input.record.id).state, "validated");
  catalog.close();
  assert.equal((await reconcileSerumValidation({ ...args, apply: true })).updated, false);
});

test("Serum validation rejects incomplete mappings and changed NKS bytes", async () => {
  const input = await fixture();
  const args = { manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, reportPath: input.reportPath, apply: true };
  await writeFile(input.reportPath, JSON.stringify({ ...input.report,
    controller: { ...input.report.controller, pages: [{ name: "Main", controls: [{ name: "Cutoff", displayValue: "50%" }] }] } }));
  await assert.rejects(reconcileSerumValidation(args), /eight.*controls/);
  await writeFile(input.reportPath, JSON.stringify(input.report));
  await writeFile(input.nksPath, "changed NKS bytes");
  await assert.rejects(reconcileSerumValidation(args), /NKS.*checksum/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "previewed");
});

test("Serum validation CLI plans without mutation and applies only with an explicit flag", async () => {
  const input = await fixture();
  const script = new URL("../scripts/reconcile-serum-validation.mjs", import.meta.url).pathname;
  const args = [script, "--manifest", input.manifestPath, "--catalog", input.catalogPath,
    "--preset-id", input.record.id, "--report", input.reportPath];
  const dry = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
  assert.equal(dry.dryRun, true);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "previewed");
  const applied = JSON.parse(execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8" }));
  assert.equal(applied.updated, true);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "validated");
});

test("root Serum validation command reaches the pipeline CLI", async () => {
  const input = await fixture();
  const root = new URL("../../..", import.meta.url).pathname;
  const stdout = execFileSync("npm", ["run", "catalog:reconcile-serum-validation", "--",
    "--manifest", input.manifestPath, "--catalog", input.catalogPath,
    "--preset-id", input.record.id, "--report", input.reportPath],
  { cwd: root, encoding: "utf8" });
  assert.match(stdout, /"dryRun":true/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "previewed");
});

test("Serum validation refuses divergent catalog validation on retry", async () => {
  const input = await fixture();
  const args = { manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, reportPath: input.reportPath, apply: true };
  await reconcileSerumValidation(args);
  const catalog = Catalog.open(input.catalogPath);
  const current = catalog.get(input.record.id);
  catalog.upsert({ ...current, evidence: current.evidence.map(item => item.state === "validated"
    ? { ...item, reportSha256: "b".repeat(64) } : item) });
  catalog.close();
  await assert.rejects(reconcileSerumValidation(args), /catalog validation evidence mismatch/);
});

test("Serum validation dry run does not create a missing catalog", async () => {
  const input = await fixture();
  await unlink(input.catalogPath);
  await assert.rejects(reconcileSerumValidation({ manifestPath: input.manifestPath,
    catalogPath: input.catalogPath, presetId: input.record.id, reportPath: input.reportPath }), /catalog/);
  await assert.rejects(stat(input.catalogPath), { code: "ENOENT" });
});
