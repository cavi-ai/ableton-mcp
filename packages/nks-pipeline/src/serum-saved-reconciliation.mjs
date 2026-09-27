import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { Catalog } from "./catalog.mjs";
import { transitionPreset } from "./domain.mjs";
import { KompleteBrowser } from "./komplete-browser.mjs";
import { ManifestStore } from "./manifest-store.mjs";
import { serumNksName } from "./serum-nks-name.mjs";
export { serumNksName } from "./serum-nks-name.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function inside(root, file) {
  const remainder = relative(root, file);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith("../") && !isAbsolute(remainder);
}

export async function reconcileSerumSaved({ manifestPath, catalogPath, runLogPath, browserPath,
  userContentRoot, apply = false }) {
  const store = await ManifestStore.open(manifestPath);
  const runLines = (await readFile(runLogPath, "utf8")).split(/\r?\n/).filter(Boolean);
  const browser = KompleteBrowser.open(browserPath);
  const database = new DatabaseSync(catalogPath, { readOnly: true });
  const root = await realpath(userContentRoot);
  const planned = [];
  const seen = new Set();
  try {
    const catalogRow = database.prepare("SELECT state, json FROM presets WHERE id = ?");
    for (const line of runLines) {
      const run = JSON.parse(line);
      if (!run.id || seen.has(run.id)) throw new Error(`duplicate or missing run ID ${run.id}`);
      seen.add(run.id);
      const record = store.get(run.id);
      if (!record || record.productSlug !== "serum-2") throw new Error(`unknown Serum preset ${run.id}`);
      const row = catalogRow.get(run.id);
      if (!row || JSON.parse(row.json).sourceFingerprint !== record.sourceFingerprint)
        throw new Error(`catalog source fingerprint changed for ${run.id}`);
      if (!["discovered", "nks_saved"].includes(record.state) ||
          !["discovered", "nks_saved"].includes(row.state))
        throw new Error(`preset ${run.id} is not eligible for saved-state reconciliation`);
      if (run.state !== "nks_saved" || run.sourcePath !== record.sourcePath ||
          run.expectedDisplayName !== record.name || run.observedDisplayName !== record.name ||
          run.nksName !== serumNksName(record))
        throw new Error(`source identity evidence mismatch for ${run.id}`);
      if (`sha256:${sha256(await readFile(record.sourcePath))}` !== record.sourceFingerprint)
        throw new Error(`source fingerprint changed for ${run.id}`);
      const fileName = `${run.nksName}.nksf`;
      const indexed = browser.findSavedPreset({ name: run.nksName, product: "Serum 2",
        fileName, userContentRoot });
      if (!indexed) throw new Error(`NKS preset ${run.id} is not indexed by Komplete`);
      const file = await realpath(indexed.fileName);
      if (!inside(root, file) || basename(file) !== fileName)
        throw new Error(`NKS file escaped user content root for ${run.id}`);
      const info = await stat(file);
      if (!info.isFile() || info.size <= 0) throw new Error(`NKS artifact is empty or not a file for ${run.id}`);
      const artifact = { path: indexed.fileName, size: info.size, sha256: sha256(await readFile(file)) };
      const existingHash = record.evidence?.findLast(item => item.state === "nks_saved")?.artifact?.sha256;
      if (record.state === "nks_saved" && existingHash !== artifact.sha256)
        throw new Error(`saved artifact fingerprint changed for ${run.id}`);
      if (record.state === "nks_saved" && row.state === "nks_saved") continue;
      const loading = record.state === "discovered"
        ? transitionPreset(record, "loading", { kind: "reconciled_prior_save", reportedAt: run.at }) : record;
      const saved = record.state === "discovered"
        ? transitionPreset(loading, "nks_saved", { kind: "komplete_index_and_file_verified",
          reportedSourceDisplayName: run.observedDisplayName, reportedAt: run.at,
          sourceFingerprint: record.sourceFingerprint, browser: indexed, artifact }) : record;
      planned.push(saved);
    }
  } finally {
    database.close();
    browser.close();
  }
  if (!apply) return { dryRun: true, plannedIds: planned.map(record => record.id), updatedIds: [] };
  if (planned.length) {
    for (const record of planned) await store.upsert(record);
    await store.flush();
    const catalog = Catalog.open(catalogPath);
    try {
      catalog.database.exec("BEGIN IMMEDIATE");
      for (const record of planned) catalog.upsert(record);
      catalog.database.exec("COMMIT");
    } catch (error) {
      catalog.database.exec("ROLLBACK");
      throw error;
    } finally { catalog.close(); }
  }
  return { dryRun: false, plannedIds: planned.map(record => record.id), updatedIds: planned.map(record => record.id) };
}
