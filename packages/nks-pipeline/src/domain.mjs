import { createHash } from "node:crypto";
import { relative, sep } from "node:path";

const transitions = {
  discovered: new Set(["loading", "quarantined"]),
  loading: new Set(["discovered", "nks_saved", "quarantined"]),
  nks_saved: new Set(["previewed", "quarantined"]),
  previewed: new Set(["validated", "quarantined"]),
  validated: new Set(),
  quarantined: new Set()
};

function relativeSourcePath({ sourceRoot, sourcePath }) {
  const value = relative(sourceRoot, sourcePath).split(sep).join("/");
  if (!value || value.startsWith("../") || value === "..") {
    throw new Error("sourcePath must be inside sourceRoot");
  }
  return value;
}

export function stablePresetId(discovery) {
  const key = `${discovery.productSlug}\0${relativeSourcePath(discovery).normalize("NFC")}`;
  return `${discovery.productSlug}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export function createPresetRecord(discovery) {
  const record = {
    id: stablePresetId(discovery),
    productSlug: discovery.productSlug,
    sourceRoot: discovery.sourceRoot,
    sourcePath: discovery.sourcePath,
    sourceRelativePath: relativeSourcePath(discovery),
    name: discovery.name,
    bank: discovery.bank,
    subBank: discovery.subBank,
    types: [...discovery.types],
    modes: [...discovery.modes],
    author: discovery.author,
    sourceFingerprint: discovery.sourceFingerprint,
    state: "discovered",
    attempts: 0,
    evidence: []
  };
  if (discovery.sourceContainerPath) record.sourceContainerPath = discovery.sourceContainerPath;
  if (discovery.sourceEntryName) record.sourceEntryName = discovery.sourceEntryName;
  return Object.freeze(record);
}

export function transitionPreset(record, nextState, evidence = {}) {
  if (!transitions[record.state]?.has(nextState)) {
    throw new Error(`invalid transition ${record.state} -> ${nextState}`);
  }
  return Object.freeze({
    ...record,
    state: nextState,
    evidence: [
      ...record.evidence,
      { state: nextState, at: new Date().toISOString(), ...evidence }
    ]
  });
}
