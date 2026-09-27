import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, realpath } from "node:fs/promises";
import { Catalog } from "./catalog.mjs";
import { transitionPreset } from "./domain.mjs";
import { ManifestStore } from "./manifest-store.mjs";
import { inspectPreview } from "./preview-runner.mjs";
import { serumNksName } from "./serum-nks-name.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

async function evidenceFile(path, expectedHash) {
  if (typeof path !== "string" || !digest(expectedHash)) throw new Error("observation evidence path and checksum are required");
  const canonicalPath = await realpath(path);
  const bytes = await readFile(canonicalPath);
  if (!bytes.length || sha256(bytes) !== expectedHash) throw new Error("observation evidence checksum mismatch");
  return { path: canonicalPath, sha256: expectedHash };
}

function controllerPages(controller) {
  if (controller?.model !== "Komplete Kontrol S88 MK3" || !Array.isArray(controller.pages) || !controller.pages.length)
    throw new Error("S88 MK3 controller pages are required");
  const seen = new Set();
  let count = 0;
  for (const page of controller.pages) {
    if (typeof page.name !== "string" || !page.name.trim() || !Array.isArray(page.controls))
      throw new Error("S88 MK3 page labels and controls are required");
    for (const control of page.controls) {
      if (typeof control.name !== "string" || !control.name.trim() ||
          typeof control.displayValue !== "string" || !control.displayValue.trim())
        throw new Error("S88 MK3 control name and display value are required");
      const key = `${page.name}\0${control.name}`;
      if (seen.has(key)) throw new Error("duplicate S88 MK3 control mapping");
      seen.add(key);
      count += 1;
    }
  }
  if (count < 8) throw new Error("at least eight exposed S88 MK3 controls are required");
  return count;
}

export async function reconcileSerumValidation({ manifestPath, catalogPath, presetId, reportPath,
  apply = false }) {
  if (typeof presetId !== "string" || !presetId.trim()) throw new Error("presetId is required");
  const store = await ManifestStore.open(manifestPath);
  const record = store.get(presetId);
  if (!record || record.productSlug !== "serum-2" || !["previewed", "validated"].includes(record.state))
    throw new Error(`Serum preset ${presetId} is not previewed`);
  let database;
  try { database = new DatabaseSync(catalogPath, { readOnly: true }); }
  catch (error) { throw new Error("catalog could not be opened read-only", { cause: error }); }
  try {
    const row = database.prepare("SELECT state, json FROM presets WHERE id = ?").get(presetId);
    const current = row && { ...JSON.parse(row.json), state: row.state };
    if (!current || current.sourceFingerprint !== record.sourceFingerprint ||
        !["previewed", "validated"].includes(current.state))
      throw new Error(`catalog state or source fingerprint mismatch for ${presetId}`);
    const nks = record.evidence?.findLast(item => item.state === "nks_saved");
    const preview = record.evidence?.findLast(item => item.state === "previewed");
    if (nks?.kind !== "komplete_index_and_file_verified" || !digest(nks.artifact?.sha256) ||
        preview?.kind !== "reported_capture_and_measured_audio" || !digest(preview.artifact?.sha256))
      throw new Error(`saved NKS and measured preview evidence are required for ${presetId}`);
    if (current.evidence?.findLast(item => item.state === "nks_saved")?.artifact?.sha256 !== nks.artifact.sha256 ||
        current.evidence?.findLast(item => item.state === "previewed")?.artifact?.sha256 !== preview.artifact.sha256)
      throw new Error(`catalog artifact evidence mismatch for ${presetId}`);
    if (`sha256:${sha256(await readFile(record.sourcePath))}` !== record.sourceFingerprint)
      throw new Error(`source fingerprint changed for ${presetId}`);
    if (sha256(await readFile(await realpath(nks.artifact.path))) !== nks.artifact.sha256)
      throw new Error(`NKS artifact checksum changed for ${presetId}`);
    const measuredPreview = await inspectPreview(await realpath(preview.artifact.path));
    if (measuredPreview.sha256 !== preview.artifact.sha256)
      throw new Error(`preview checksum changed for ${presetId}`);
    const reportBytes = await readFile(reportPath);
    const report = JSON.parse(reportBytes.toString("utf8"));
    if (report.format !== "cavi-serum-validation-v1" || report.presetId !== presetId ||
        report.sourceFingerprint !== record.sourceFingerprint ||
        report.nksSha256 !== nks.artifact.sha256 || report.previewSha256 !== preview.artifact.sha256)
      throw new Error(`validation report identity mismatch for ${presetId}`);
    if (report.recall?.observedNksName !== serumNksName(record) ||
        report.recall?.observedProduct !== "Serum 2")
      throw new Error(`Komplete recall identity mismatch for ${presetId}`);
    const controllerControlCount = controllerPages(report.controller);
    const recallEvidence = await evidenceFile(report.recall.evidencePath, report.recall.evidenceSha256);
    const controllerEvidence = await evidenceFile(report.controller.evidencePath, report.controller.evidenceSha256);
    const reportSha256 = sha256(reportBytes);
    const existing = record.evidence?.findLast(item => item.state === "validated");
    if (record.state === "validated" && (existing?.kind !== "operator_reported_recall_controller_verified" ||
        existing.reportSha256 !== reportSha256)) throw new Error(`validation report changed for ${presetId}`);
    if (current.state === "validated" && (record.state !== "validated" ||
        current.evidence?.findLast(item => item.state === "validated")?.reportSha256 !== reportSha256))
      throw new Error(`catalog validation evidence mismatch for ${presetId}`);
    const updated = record.state === "previewed" ? transitionPreset(record, "validated", {
      kind: "operator_reported_recall_controller_verified", reportSha256, controllerControlCount,
      recall: { observedNksName: report.recall.observedNksName, observedProduct: "Serum 2", evidence: recallEvidence },
      controller: { model: report.controller.model, pages: report.controller.pages, evidence: controllerEvidence }
    }) : record;
    if (!apply) return { dryRun: true, presetId, planned: record.state !== "validated" || current.state !== "validated",
      updated: false, controllerControlCount, reportSha256 };
    if (record.state === "validated" && current.state === "validated")
      return { dryRun: false, presetId, updated: false, controllerControlCount, reportSha256 };
    await store.upsert(updated);
    await store.flush();
    const catalog = Catalog.open(catalogPath);
    try { catalog.upsert(updated); }
    finally { catalog.close(); }
    return { dryRun: false, presetId, updated: true, controllerControlCount, reportSha256 };
  } finally { database.close(); }
}
