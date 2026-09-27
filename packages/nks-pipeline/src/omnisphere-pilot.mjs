const compare = (left, right) => left.bank.localeCompare(right.bank) ||
  left.sourceEntryName.localeCompare(right.sourceEntryName) || left.id.localeCompare(right.id);

const inUserSource = value => value.split("/").some(part => part.toLowerCase() === "user");
const categoryOf = record => record.subBank.split("/")[0];

function nksName(record) {
  const safe = [record.bank, ...record.subBank.split("/"), record.name]
    .map(part => part.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim())
    .join(" - ").slice(0, 180).trim();
  return `CAVI Omnisphere - ${safe} - ${record.id.split(":").at(-1).slice(0, 12)}`;
}

export function buildOmnispherePilot(records, { requestedSize = 25 } = {}) {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  if (!Number.isSafeInteger(requestedSize) || requestedSize < 1)
    throw new Error("requestedSize must be positive");
  const sorted = records.filter(record => record.productSlug === "omnisphere" && !record.missing &&
    !inUserSource(record.sourceEntryName ?? "") && !inUserSource(record.sourceRelativePath ?? ""))
    .sort(compare);
  if (!sorted.length) throw new Error("no eligible Omnisphere factory presets");
  for (const record of sorted) {
    if (!["id", "name", "bank", "subBank", "sourceContainerPath", "sourceEntryName",
      "sourceFingerprint"].every(key => typeof record[key] === "string" && record[key]))
      throw new Error("Omnisphere pilot requires complete source and browser identity");
  }
  const selected = new Map();
  const add = record => { if (record) selected.set(record.id, record); };
  add(sorted[0]);
  add(sorted.at(-1));
  const banks = [...new Set(sorted.map(record => record.bank))].sort();
  for (const bank of banks) {
    const inBank = sorted.filter(record => record.bank === bank);
    add(inBank[0]);
    add(inBank.at(-1));
  }
  const categories = [...new Set(sorted.map(categoryOf))].sort();
  for (const category of categories) add(sorted.find(record => categoryOf(record) === category));
  const target = Math.min(sorted.length, Math.max(requestedSize, selected.size));
  for (const record of sorted) {
    if (selected.size >= target) break;
    add(record);
  }
  const chosen = [...selected.values()].sort(compare);
  return { version: 1, productSlug: "omnisphere", readiness: "source_only_unverified",
    requestedSize, actualSize: chosen.length,
    adjustment: chosen.length > requestedSize
      ? { reason: "category_or_bank_coverage_requires_larger_pilot" } : undefined,
    coverage: { first: selected.has(sorted[0].id), last: selected.has(sorted.at(-1).id), banks,
      missingBanks: banks.filter(bank => !chosen.some(record => record.bank === bank)), categories,
      missingCategories: categories.filter(category => !chosen.some(record => categoryOf(record) === category)) },
    jobs: chosen.map(record => {
      const name = nksName(record);
      return { id: record.id, sourceFingerprint: record.sourceFingerprint,
        sourceContainerPath: record.sourceContainerPath, sourceEntryName: record.sourceEntryName,
        expectedDisplayName: record.name,
        browserPath: { method: "plugin_browser", bank: record.bank,
          categoryPath: record.subBank.split("/"), presetName: record.name },
        navigationVerification: "unverified", nksName: name,
        evidenceQuery: { name, product: "Omnisphere", fileName: `${name}.nksf` } };
    }) };
}
