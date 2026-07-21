import { createHash } from "node:crypto";

const levels = new Set(["product", "bank", "variant"]);
const transitions = {
  planned: new Set(["generated", "rejected"]),
  generated: new Set(["validated", "rejected"]),
  validated: new Set(["approved", "rejected"]),
  approved: new Set(),
  rejected: new Set()
};

function normalized(value) {
  return String(value ?? "").normalize("NFC");
}

export function stableArtworkId(tuple, level) {
  if (!levels.has(level)) throw new Error(`invalid artwork level ${level}`);
  const key = [
    level,
    tuple.productSlug,
    tuple.library,
    tuple.bank,
    tuple.subBank,
    tuple.category
  ]
    .map(normalized)
    .join("\0");
  return `art:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export function createArtworkRecord(input) {
  const { level, promptVersion } = input;
  if (!levels.has(level)) throw new Error(`invalid artwork level ${level}`);
  if (!Number.isInteger(promptVersion) || promptVersion < 1) {
    throw new Error("promptVersion must be a positive integer");
  }
  const tuple = {
    productSlug: normalized(input.productSlug),
    library: normalized(input.library),
    bank: normalized(input.bank),
    subBank: normalized(input.subBank),
    category: normalized(input.category)
  };
  return Object.freeze({
    id: stableArtworkId(tuple, level),
    level,
    ...tuple,
    promptVersion,
    state: "planned",
    evidence: Object.freeze([])
  });
}

export function transitionArtwork(record, nextState, evidence = {}) {
  if (!transitions[record.state]?.has(nextState)) {
    throw new Error(`invalid artwork transition ${record.state} -> ${nextState}`);
  }
  const entry = Object.freeze({
    state: nextState,
    at: new Date().toISOString(),
    ...evidence
  });
  return Object.freeze({
    ...record,
    state: nextState,
    evidence: Object.freeze([...record.evidence, entry])
  });
}
