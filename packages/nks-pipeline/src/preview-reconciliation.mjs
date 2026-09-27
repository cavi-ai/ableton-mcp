import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "./catalog.mjs";
import { transitionPreset } from "./domain.mjs";
import { ManifestStore } from "./manifest-store.mjs";
import { inspectPreview, runPreview } from "./preview-runner.mjs";

export async function reconcilePreview({ manifestPath, catalogPath, presetId, previewPath,
  expectedSha256, captureReportPath, apply = false }) {
  if (typeof presetId !== "string" || !presetId.trim()) throw new Error("presetId is required");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("expectedSha256 must be a SHA-256 digest");
  if (typeof captureReportPath !== "string" || !captureReportPath.trim())
    throw new Error("capture report is required");
  const store = await ManifestStore.open(manifestPath);
  const record = store.get(presetId);
  if (!record || !["nks_saved", "previewed"].includes(record.state))
    throw new Error(`preset ${presetId} is not nks_saved or previewed`);
  if (!record.evidence?.some(item => item.state === "nks_saved" &&
      item.kind === "komplete_index_and_file_verified" && /^[0-9a-f]{64}$/.test(item.artifact?.sha256)))
    throw new Error(`preset ${presetId} lacks verified NKS artifact evidence`);
  const catalog = Catalog.open(catalogPath);
  try {
    const current = catalog.get(presetId);
    if (!current || current.sourceFingerprint !== record.sourceFingerprint ||
        !["nks_saved", "previewed"].includes(current.state))
      throw new Error(`catalog state or source fingerprint mismatch for ${presetId}`);
    const savedHash = record.evidence.findLast(item => item.state === "nks_saved")?.artifact?.sha256;
    if (current.evidence?.findLast(item => item.state === "nks_saved")?.artifact?.sha256 !== savedHash)
      throw new Error(`catalog NKS artifact evidence mismatch for ${presetId}`);
    const sourceFingerprint = `sha256:${createHash("sha256").update(await readFile(record.sourcePath)).digest("hex")}`;
    if (sourceFingerprint !== record.sourceFingerprint) throw new Error(`source fingerprint changed for ${presetId}`);
    const artifact = await inspectPreview(await realpath(previewPath));
    if (artifact.sha256 !== expectedSha256) throw new Error(`preview checksum mismatch for ${presetId}`);
    const capture = JSON.parse(await readFile(captureReportPath, "utf8"));
    if (capture.kind !== "reported_ableton_live_capture" || capture.presetId !== presetId ||
        capture.sourceFingerprint !== record.sourceFingerprint || capture.nksSha256 !== savedHash ||
        capture.previewSha256 !== artifact.sha256)
      throw new Error(`capture report preset or artifact identity mismatch for ${presetId}`);
    if (typeof capture.rawPath !== "string" || typeof capture.rawSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(capture.rawSha256)) throw new Error("capture report raw audio is invalid");
    const rawPath = await realpath(capture.rawPath);
    const rawHash = createHash("sha256").update(await readFile(rawPath)).digest("hex");
    if (rawHash !== capture.rawSha256) throw new Error(`capture report raw audio checksum mismatch for ${presetId}`);
    const verificationDirectory = await mkdtemp(join(tmpdir(), "nks-preview-lineage-"));
    try {
      const reproduced = await runPreview({ rawPath, finalPath: join(verificationDirectory, "preview.wav") });
      if (reproduced.sha256 !== artifact.sha256)
        throw new Error(`capture report raw audio did not produce preview for ${presetId}`);
    } finally { await rm(verificationDirectory, { recursive: true, force: true }); }
    const captureEvidence = { kind: capture.kind, rawPath, rawSha256: rawHash };
    const existing = record.evidence?.findLast(item => item.state === "previewed")?.artifact;
    if (record.state === "previewed" && (existing?.sha256 !== artifact.sha256 ||
        existing?.path !== artifact.path)) throw new Error(`preview evidence mismatch for ${presetId}`);
    if (current.state === "previewed") {
      const catalogPreview = current.evidence?.findLast(item => item.state === "previewed")?.artifact;
      if (catalogPreview?.sha256 !== artifact.sha256 || catalogPreview?.path !== artifact.path)
        throw new Error(`catalog preview evidence mismatch for ${presetId}`);
    }
    const updated = record.state === "nks_saved"
      ? transitionPreset(record, "previewed", { kind: "reported_capture_and_measured_audio", artifact,
        capture: captureEvidence }) : record;
    if (!apply) return { dryRun: true, presetId, updated: false, planned: record.state !== "previewed" || current.state !== "previewed", artifact };
    if (record.state === "previewed" && current.state === "previewed") return { dryRun: false, presetId, updated: false, artifact };
    await store.upsert(updated);
    await store.flush();
    catalog.upsert(updated);
    return { dryRun: false, presetId, updated: true, artifact };
  } finally { catalog.close(); }
}
