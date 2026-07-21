import { readFileSync } from "node:fs";

const expectedCategories = new Set([
  "bass",
  "lead",
  "pad",
  "pluck",
  "keys",
  "strings",
  "brass",
  "drums",
  "percussion",
  "sequence",
  "arpeggio",
  "effects",
  "atmosphere",
  "vocals",
  "miscellaneous"
]);

function isHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function loadCategoryConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const categories = Array.isArray(config.categories) ? config.categories : [];
  const ids = new Set(categories.map(({ id }) => id));
  const symbols = new Set(categories.map(({ symbol }) => symbol));
  const valid =
    config.version === 1 &&
    categories.length === expectedCategories.size &&
    ids.size === expectedCategories.size &&
    symbols.size === expectedCategories.size &&
    [...expectedCategories].every((id) => ids.has(id)) &&
    categories.every(
      ({ id, symbol, accent, aliases }) =>
        typeof id === "string" &&
        typeof symbol === "string" &&
        symbol.length > 0 &&
        isHexColor(accent) &&
        Array.isArray(aliases) &&
        aliases.every((alias) => typeof alias === "string" && alias.length > 0)
    );
  if (!valid) throw new Error("invalid artwork category config");
  return config;
}

export function normalizeArtworkCategory(record, config) {
  const tiers = [
    [record.name],
    record.modes || [],
    record.types || [],
    [record.subBank, record.bank],
    [record.sourceRelativePath]
  ];
  for (const values of tiers) {
    const haystack = values
      .filter(Boolean)
      .join(" ")
      .normalize("NFC")
      .toLowerCase();
    for (const category of config.categories) {
      if (category.aliases.some((alias) => {
        const escaped = alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(haystack);
      })) {
        return category.id;
      }
    }
  }
  return "miscellaneous";
}
