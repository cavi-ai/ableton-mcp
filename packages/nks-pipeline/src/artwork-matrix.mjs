import { createArtworkRecord, stableArtworkId } from "./artwork-domain.mjs";
import { normalizeArtworkCategory } from "./artwork-categories.mjs";

function normalize(value) {
  return String(value ?? "").normalize("NFC");
}

function libraryFor(record) {
  if (record.library) return normalize(record.library);
  const [first = "Factory"] = normalize(record.sourceRelativePath)
    .split("/")
    .filter(Boolean);
  return first || "Factory";
}

function addRecord(records, input, parents = {}) {
  const created = createArtworkRecord(input);
  if (!records.has(created.id)) {
    records.set(created.id, Object.freeze({ ...created, ...parents }));
  }
  return created.id;
}

export function buildArtworkMatrix(
  presetRecords,
  { categoryConfig, promptVersion, productConfig } = {}
) {
  if (!categoryConfig) throw new Error("categoryConfig is required");
  if (!Number.isInteger(promptVersion) || promptVersion < 1) {
    throw new Error("promptVersion must be a positive integer");
  }

  const records = new Map();
  const assignments = [];
  const seenPresetIds = new Set();

  for (const productSlug of Object.keys(productConfig?.products || {}).sort()) {
    addRecord(records, {
      productSlug,
      library: "",
      bank: "",
      subBank: "",
      category: "",
      promptVersion,
      level: "product"
    });
  }

  for (const preset of [...presetRecords].sort((left, right) =>
    normalize(left.id).localeCompare(normalize(right.id))
  )) {
    if (!preset.id) throw new Error("preset id is required");
    if (seenPresetIds.has(preset.id)) throw new Error(`duplicate preset ${preset.id}`);
    seenPresetIds.add(preset.id);
    if (!preset.productSlug) throw new Error(`productSlug is required for ${preset.id}`);
    if (productConfig && !productConfig.products?.[preset.productSlug]) {
      throw new Error(`missing artwork product brief for ${preset.productSlug}`);
    }

    const common = {
      productSlug: normalize(preset.productSlug),
      library: libraryFor(preset),
      bank: normalize(preset.bank) || "Factory",
      subBank: normalize(preset.subBank),
      category: normalizeArtworkCategory(preset, categoryConfig),
      promptVersion
    };
    const productTuple = {
      ...common,
      library: "",
      bank: "",
      subBank: "",
      category: "",
      level: "product"
    };
    const productArtworkId = addRecord(records, productTuple);
    const bankTuple = { ...common, category: "", level: "bank" };
    const bankArtworkId = addRecord(records, bankTuple, { productArtworkId });
    const variantTuple = { ...common, level: "variant" };
    const artworkId = addRecord(records, variantTuple, {
      productArtworkId,
      bankArtworkId
    });

    if (artworkId !== stableArtworkId(variantTuple, "variant")) {
      throw new Error(`unstable artwork assignment for ${preset.id}`);
    }
    assignments.push(Object.freeze({ presetId: preset.id, artworkId }));
  }

  if (assignments.length !== seenPresetIds.size) {
    throw new Error("not every preset received an artwork assignment");
  }

  return Object.freeze({
    records: Object.freeze(
      [...records.values()].sort((left, right) => left.id.localeCompare(right.id))
    ),
    assignments: Object.freeze(
      assignments.sort((left, right) =>
        left.presetId.localeCompare(right.presetId) ||
        left.artworkId.localeCompare(right.artworkId)
      )
    )
  });
}
