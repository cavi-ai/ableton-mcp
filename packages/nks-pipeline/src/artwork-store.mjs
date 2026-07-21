import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function sortedStore(store) {
  return {
    version: 1,
    promptVersion: store.promptVersion,
    records: [...store.records].sort((left, right) => left.id.localeCompare(right.id)),
    assignments: [...store.assignments].sort((left, right) =>
      left.presetId.localeCompare(right.presetId) || left.artworkId.localeCompare(right.artworkId)
    )
  };
}

export function loadArtworkStore(path, { promptVersion = 1 } = {}) {
  if (!existsSync(path)) {
    return { version: 1, promptVersion, records: [], assignments: [] };
  }
  const store = JSON.parse(readFileSync(path, "utf8"));
  if (
    store.version !== 1 ||
    !Number.isInteger(store.promptVersion) ||
    !Array.isArray(store.records) ||
    !Array.isArray(store.assignments)
  ) {
    throw new Error("invalid artwork store");
  }
  return sortedStore(store);
}

export function saveArtworkStore(path, store) {
  const stable = sortedStore(store);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(stable, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

export function mergeArtworkRecords(existingRecords, incomingRecords) {
  const merged = new Map(existingRecords.map((record) => [record.id, record]));
  for (const incoming of incomingRecords) {
    const existing = merged.get(incoming.id);
    if (
      existing?.state === "approved" &&
      existing.promptVersion === incoming.promptVersion
    ) {
      continue;
    }
    merged.set(incoming.id, incoming);
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}
