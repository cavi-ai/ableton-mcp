import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "../src/catalog.mjs";
import { ManifestStore } from "../src/manifest-store.mjs";
import { runPreview } from "../src/preview-runner.mjs";
import { reconcilePreview } from "../src/preview-reconciliation.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nks-preview-reconcile-"));
  const manifestPath = join(directory, "manifest.json");
  const catalogPath = join(directory, "catalog.sqlite");
  const rawPath = join(directory, "raw.wav");
  const previewPath = join(directory, "preview.wav");
  const captureReportPath = join(directory, "capture.json");
  const sourcePath = join(directory, "factory.fxp");
  await writeFile(sourcePath, "factory source");
  const record = { id: "serum-2:a", productSlug: "serum-2", name: "A", bank: "Factory",
    subBank: "Bass", author: "Xfer", sourcePath,
    sourceFingerprint: `sha256:${createHash("sha256").update("factory source").digest("hex")}`,
    state: "nks_saved", evidence: [{ state: "nks_saved", kind: "komplete_index_and_file_verified",
      artifact: { sha256: "a".repeat(64) } }] };
  const manifest = await ManifestStore.open(manifestPath);
  await manifest.upsert(record);
  await manifest.flush();
  const catalog = Catalog.open(catalogPath);
  catalog.upsert(record);
  catalog.close();
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000:duration=12", "-c:a", "pcm_s24le", rawPath]);
  const result = await runPreview({ rawPath, finalPath: previewPath });
  const capture = { kind: "reported_ableton_live_capture", presetId: record.id,
    sourceFingerprint: record.sourceFingerprint, nksSha256: "a".repeat(64),
    rawPath, rawSha256: createHash("sha256").update(await readFile(rawPath)).digest("hex"),
    previewSha256: result.sha256 };
  await writeFile(captureReportPath, JSON.stringify(capture));
  return { manifestPath, catalogPath, rawPath, previewPath, captureReportPath, capture, record, result, sourcePath };
}

test("preview reconciliation refuses audio without a preset-bound capture report", async () => {
  const input = await fixture();
  await assert.rejects(reconcilePreview({ manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, previewPath: input.previewPath, expectedSha256: input.result.sha256,
    apply: true }), /capture report/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
});

test("preview reconciliation verifies audio and advances matching manifest and catalog only on apply", async () => {
  const input = await fixture();
  const args = { manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, previewPath: input.previewPath, expectedSha256: input.result.sha256,
    captureReportPath: input.captureReportPath };
  assert.equal((await reconcilePreview(args)).dryRun, true);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
  assert.equal((await reconcilePreview({ ...args, apply: true })).updated, true);
  const saved = (await ManifestStore.open(input.manifestPath)).get(input.record.id);
  assert.equal(saved.state, "previewed");
  assert.equal(saved.evidence.at(-1).artifact.sha256, input.result.sha256);
  const catalog = Catalog.open(input.catalogPath);
  assert.equal(catalog.get(input.record.id).state, "previewed");
  catalog.close();
  assert.equal((await reconcilePreview({ ...args, apply: true })).updated, false);
});

test("preview reconciliation rejects wrong checksum and changed source without advancing", async () => {
  const input = await fixture();
  const args = { manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, previewPath: input.previewPath, expectedSha256: "b".repeat(64),
    captureReportPath: input.captureReportPath, apply: true };
  await assert.rejects(reconcilePreview(args), /checksum/);
  await writeFile(input.sourcePath, "changed source");
  await assert.rejects(reconcilePreview({ ...args, expectedSha256: input.result.sha256 }), /source fingerprint changed/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
  const catalog = Catalog.open(input.catalogPath);
  assert.equal(catalog.get(input.record.id).state, "nks_saved");
  catalog.close();
});

test("preview reconciliation CLI defaults to dry run and advances on explicit apply", async () => {
  const input = await fixture();
  const script = new URL("../scripts/reconcile-preview.mjs", import.meta.url).pathname;
  const args = [script, "--manifest", input.manifestPath, "--catalog", input.catalogPath,
    "--preset-id", input.record.id, "--preview", input.previewPath, "--sha256", input.result.sha256,
    "--capture-report", input.captureReportPath];
  const dry = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.planned, true);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
  const applied = JSON.parse(execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8" }));
  assert.equal(applied.updated, true);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "previewed");
});

test("root preview reconciliation command reaches the pipeline CLI", async () => {
  const input = await fixture();
  const root = new URL("../../..", import.meta.url).pathname;
  const stdout = execFileSync("npm", ["run", "catalog:reconcile-preview", "--",
    "--manifest", input.manifestPath, "--catalog", input.catalogPath,
    "--preset-id", input.record.id, "--preview", input.previewPath,
    "--sha256", input.result.sha256, "--capture-report", input.captureReportPath],
  { cwd: root, encoding: "utf8" });
  assert.match(stdout, /"dryRun":true/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
});

test("preview reconciliation refuses divergent catalog evidence", async () => {
  const input = await fixture();
  const catalog = Catalog.open(input.catalogPath);
  catalog.upsert({ ...input.record, evidence: [{ state: "nks_saved", kind: "komplete_index_and_file_verified",
    artifact: { sha256: "b".repeat(64) } }] });
  catalog.close();
  await assert.rejects(reconcilePreview({ manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, previewPath: input.previewPath, expectedSha256: input.result.sha256,
    captureReportPath: input.captureReportPath, apply: true }), /catalog.*NKS artifact/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
});

test("preview reconciliation rejects a capture report for another preset or raw audio", async () => {
  const input = await fixture();
  const args = { manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, previewPath: input.previewPath, expectedSha256: input.result.sha256,
    captureReportPath: input.captureReportPath, apply: true };
  await writeFile(input.captureReportPath, JSON.stringify({ ...input.capture, presetId: "serum-2:other" }));
  await assert.rejects(reconcilePreview(args), /capture report.*preset/);
  await writeFile(input.captureReportPath, JSON.stringify({ ...input.capture, rawSha256: "b".repeat(64) }));
  await assert.rejects(reconcilePreview(args), /capture report.*raw audio/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
});

test("preview reconciliation rejects a raw capture that did not produce the preview", async () => {
  const input = await fixture();
  const unrelatedRaw = join(input.rawPath, "..");
  const otherPath = join(unrelatedRaw, "other.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=550:sample_rate=48000:duration=12", "-c:a", "pcm_s24le", otherPath]);
  await writeFile(input.captureReportPath, JSON.stringify({ ...input.capture, rawPath: otherPath,
    rawSha256: createHash("sha256").update(await readFile(otherPath)).digest("hex") }));
  await assert.rejects(reconcilePreview({ manifestPath: input.manifestPath, catalogPath: input.catalogPath,
    presetId: input.record.id, previewPath: input.previewPath, expectedSha256: input.result.sha256,
    captureReportPath: input.captureReportPath, apply: true }), /did not produce preview/);
  assert.equal((await ManifestStore.open(input.manifestPath)).get(input.record.id).state, "nks_saved");
});
