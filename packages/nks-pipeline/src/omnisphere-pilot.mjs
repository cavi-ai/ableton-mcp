import { dirname } from "node:path";

function compare(left, right) {
  return left.bank.localeCompare(right.bank) ||
    left.sourceEntryName.localeCompare(right.sourceEntryName) ||
    left.id.localeCompare(right.id);
}

function safe(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim();
}

export function omnisphereNksName(record) {
  const category = dirname(record.sourceEntryName).split("/").map(safe).join(" - ");
  return `CAVI Omnisphere - ${safe(record.bank)} - ${category} - ${safe(record.name)} - ${record.id.split(":").at(-1).slice(0, 8)}`;
}

export function buildOmnispherePilot(records, { size = 25 } = {}) {
  const sorted = [...records].sort(compare);
  if (sorted.length === 0) throw new Error("cannot build an Omnisphere pilot from an empty inventory");
  const selected = new Map();
  const add = (record) => record && selected.set(record.id, record);
  add(sorted[0]);
  add(sorted.at(-1));
  const banks = [...new Set(sorted.map((record) => record.bank))].sort();
  for (const bank of banks) {
    const members = sorted.filter((record) => record.bank === bank);
    add(members[0]);
    add(members[Math.floor(members.length / 2)]);
    add(members.at(-1));
  }
  for (const record of sorted) {
    if (selected.size >= Math.min(size, sorted.length)) break;
    add(record);
  }
  const chosen = [...selected.values()].sort(compare).slice(0, size);
  const chosenIds = new Set(chosen.map((record) => record.id));
  const selectedBanks = new Set(chosen.map((record) => record.bank));
  return {
    version: 1,
    productSlug: "omnisphere",
    requestedSize: size,
    actualSize: chosen.length,
    coverage: {
      first: chosenIds.has(sorted[0].id),
      last: chosenIds.has(sorted.at(-1).id),
      banks,
      missingBanks: banks.filter((bank) => !selectedBanks.has(bank))
    },
    jobs: chosen.map((record) => {
      const nksName = omnisphereNksName(record);
      return {
        id: record.id,
        sourceContainerPath: record.sourceContainerPath,
        sourceEntryName: record.sourceEntryName,
        expectedDisplayName: record.name,
        nksName,
        evidenceQuery: { name: nksName, product: "Omnisphere", fileName: `${nksName}.nksf` }
      };
    })
  };
}
