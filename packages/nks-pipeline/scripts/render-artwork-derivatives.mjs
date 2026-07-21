import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transitionArtwork } from "../src/artwork-domain.mjs";
import { loadArtworkStore, saveArtworkStore } from "../src/artwork-store.mjs";
import {
  renderBankArtwork,
  renderCategoryVariant,
  renderDerivatives
} from "../src/artwork-renderer.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const matrixPath = resolve(workspaceRoot, "reports/nks/artwork-matrix.json");
const categories = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/categories.json"), "utf8")
);
const products = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/products.json"), "utf8")
);
const derivatives = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/derivatives.json"), "utf8")
);
const categoryById = new Map(categories.categories.map((category) => [category.id, category]));
const productFilter = option("--product", "serum-2");
const bankFilter = option("--bank", "");
const limit = Number(option("--limit", "0"));
const matrix = loadArtworkStore(matrixPath, { promptVersion: products.promptVersion });
const byId = new Map(matrix.records.map((record) => [record.id, record]));

for (const productRecord of matrix.records.filter(
  (record) => record.level === "product" && record.productSlug === productFilter
)) {
  const inputPath = resolve(workspaceRoot, productRecord.path);
  const outputRoot = resolve(
    workspaceRoot,
    "artwork/nks/rendered/products",
    productRecord.productSlug
  );
  const rendered = renderDerivatives({ inputPath, outputRoot, policy: derivatives });
  byId.set(productRecord.id, { ...productRecord, derivatives: rendered });
}

let banks = matrix.records.filter(
  (record) =>
    record.level === "bank" &&
    record.productSlug === productFilter &&
    (!bankFilter || record.subBank === bankFilter || record.bank === bankFilter)
);
banks.sort((left, right) => left.id.localeCompare(right.id));
if (limit > 0) banks = banks.slice(0, limit);
if (banks.length === 0) throw new Error("no artwork banks matched the render selection");

let renderedBanks = 0;
let renderedVariants = 0;
for (const bankRecord of banks) {
  const productRecord = byId.get(bankRecord.productArtworkId);
  if (!productRecord?.path) throw new Error(`missing product master for ${bankRecord.id}`);
  const bankPath = resolve(
    workspaceRoot,
    "artwork/nks/banks",
    bankRecord.productSlug,
    `${bankRecord.id.replace(":", "-")}.png`
  );
  let updatedBank = bankRecord;
  if (updatedBank.state === "planned") {
    updatedBank = transitionArtwork(updatedBank, "generated", {
      path: relative(workspaceRoot, bankPath)
    });
  }
  const bankValidation = renderBankArtwork({
    inputPath: resolve(workspaceRoot, productRecord.path),
    outputPath: bankPath,
    artworkId: bankRecord.id
  });
  if (updatedBank.state === "generated") {
    updatedBank = transitionArtwork(updatedBank, "validated", bankValidation);
  }
  updatedBank = {
    ...updatedBank,
    path: relative(workspaceRoot, bankPath),
    ...bankValidation
  };
  byId.set(updatedBank.id, updatedBank);
  renderedBanks += 1;

  const variants = matrix.records
    .filter((record) => record.level === "variant" && record.bankArtworkId === bankRecord.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const variantRecord of variants) {
    const category = categoryById.get(variantRecord.category);
    if (!category) throw new Error(`unknown category ${variantRecord.category}`);
    const variantPath = resolve(
      workspaceRoot,
      "artwork/nks/variants",
      variantRecord.productSlug,
      `${variantRecord.id.replace(":", "-")}.png`
    );
    let updatedVariant = variantRecord;
    if (updatedVariant.state === "planned") {
      updatedVariant = transitionArtwork(updatedVariant, "generated", {
        path: relative(workspaceRoot, variantPath)
      });
    }
    const variantValidation = renderCategoryVariant({
      inputPath: bankPath,
      outputPath: variantPath,
      symbol: category.symbol,
      accent: category.accent
    });
    if (updatedVariant.state === "generated") {
      updatedVariant = transitionArtwork(updatedVariant, "validated", variantValidation);
    }
    byId.set(updatedVariant.id, {
      ...updatedVariant,
      path: relative(workspaceRoot, variantPath),
      symbol: category.symbol,
      accent: category.accent,
      ...variantValidation
    });
    renderedVariants += 1;
  }
}

saveArtworkStore(matrixPath, {
  ...matrix,
  records: [...byId.values()]
});
console.log(`rendered banks=${renderedBanks} variants=${renderedVariants}`);
