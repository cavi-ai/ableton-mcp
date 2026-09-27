import { serumNksName } from "./serum-nks-name.mjs";

const categories = ["Bass", "Lead", "Pad", "Synth", "FX", "Pluck", "Keys"];
const compareRecords = (left, right) =>
  left.sourceRelativePath.localeCompare(right.sourceRelativePath) || left.id.localeCompare(right.id);
const bankOf = record => record.sourceRelativePath.split("/")[0];
const inUserSource = record => record.sourceRelativePath.split("/").some(part => part.toLowerCase() === "user");

function matchesCategory(record, category) {
  const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i")
    .test(`${record.name} ${record.sourceRelativePath}`);
}

export function buildSerumPilot(records, { requestedSize = 25 } = {}) {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  if (!Number.isSafeInteger(requestedSize) || requestedSize < 1) throw new Error("requestedSize must be positive");
  const sorted = records.filter(record => record.productSlug === "serum-2" && !record.missing &&
    !inUserSource(record)).sort(compareRecords);
  if (!sorted.length) throw new Error("no eligible Serum factory presets");
  const selected = new Map();
  const add = record => { if (record) selected.set(record.id, record); };
  add(sorted[0]);
  add(sorted.at(-1));
  const banks = [...new Set(sorted.map(bankOf))].sort();
  for (const bank of banks) add(sorted.find(record => bankOf(record) === bank));
  for (const category of categories) add(sorted.find(record => matchesCategory(record, category)));
  const target = Math.min(sorted.length, Math.max(requestedSize, selected.size));
  for (const record of sorted) {
    if (selected.size >= target) break;
    add(record);
  }
  const chosen = [...selected.values()].sort(compareRecords);
  return {
    version: 1,
    productSlug: "serum-2",
    requestedSize,
    actualSize: chosen.length,
    adjustment: chosen.length > requestedSize
      ? { reason: "bank_coverage_requires_larger_pilot", observedBanks: banks.length } : undefined,
    coverage: {
      first: selected.has(sorted[0].id), last: selected.has(sorted.at(-1).id), banks,
      missingBanks: banks.filter(bank => !chosen.some(record => bankOf(record) === bank)),
      categories,
      missingCategories: categories.filter(category => !chosen.some(record => matchesCategory(record, category)))
    },
    jobs: chosen.map(record => {
      const nksName = serumNksName(record);
      return { id: record.id, sourcePath: record.sourcePath,
        sourceRelativePath: record.sourceRelativePath, sourceFingerprint: record.sourceFingerprint,
        expectedDisplayName: record.name, nksName,
        evidenceQuery: { name: nksName, product: "Serum 2", fileName: `${nksName}.nksf` } };
    })
  };
}
