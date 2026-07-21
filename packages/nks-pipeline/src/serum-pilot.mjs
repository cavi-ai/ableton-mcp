import { extname } from "node:path";

const REPRESENTATIVE_CATEGORIES = ["Bass", "Lead", "Pad", "Synth", "FX", "Pluck", "Keys"];

function compareRecords(left, right) {
  return left.sourceRelativePath.localeCompare(right.sourceRelativePath) || left.id.localeCompare(right.id);
}

function topLevelBank(record) {
  return record.sourceRelativePath.split("/")[0];
}

function matchesCategory(record, category) {
  const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(
    `${record.name} ${record.sourceRelativePath}`
  );
}

export function serumNksName(record) {
  const withoutExtension = record.sourceRelativePath.slice(0, -extname(record.sourceRelativePath).length);
  const safePath = withoutExtension
    .split("/")
    .map((part) => part.replace(/[<>:"\\|?*\u0000-\u001f]/g, "-").trim())
    .join(" - ");
  return `CAVI Serum2 - ${safePath} - ${record.id.split(":").at(-1).slice(0, 8)}`;
}

export function buildSerumPilot(records, { requestedSize = 25 } = {}) {
  const sorted = [...records].sort(compareRecords);
  if (sorted.length === 0) throw new Error("cannot build a Serum pilot from an empty inventory");

  const selected = new Map();
  const add = (record) => record && selected.set(record.id, record);
  add(sorted[0]);
  add(sorted.at(-1));

  const banks = [...new Set(sorted.map(topLevelBank))].sort();
  for (const bank of banks) add(sorted.find((record) => topLevelBank(record) === bank));
  for (const category of REPRESENTATIVE_CATEGORIES) {
    add(sorted.find((record) => matchesCategory(record, category)));
  }

  const targetSize = Math.min(sorted.length, Math.max(requestedSize, selected.size));
  for (const record of sorted) {
    if (selected.size >= targetSize) break;
    add(record);
  }

  const chosen = [...selected.values()].sort(compareRecords);
  const selectedBanks = new Set(chosen.map(topLevelBank));
  const jobs = chosen.map((record) => {
    const nksName = serumNksName(record);
    return {
      id: record.id,
      sourcePath: record.sourcePath,
      sourceRelativePath: record.sourceRelativePath,
      expectedDisplayName: record.name,
      nksName,
      evidenceQuery: {
        name: nksName,
        product: "Serum 2",
        fileName: `${nksName}.nksf`
      }
    };
  });

  return {
    version: 1,
    productSlug: "serum-2",
    requestedSize,
    actualSize: jobs.length,
    adjustment: jobs.length > requestedSize
      ? { reason: "bank_coverage_requires_larger_pilot", observedBanks: banks.length }
      : undefined,
    coverage: {
      first: selected.has(sorted[0].id),
      last: selected.has(sorted.at(-1).id),
      banks,
      missingBanks: banks.filter((bank) => !selectedBanks.has(bank)),
      categories: REPRESENTATIVE_CATEGORIES,
      missingCategories: REPRESENTATIVE_CATEGORIES.filter(
        (category) => !chosen.some((record) => matchesCategory(record, category))
      )
    },
    jobs
  };
}
