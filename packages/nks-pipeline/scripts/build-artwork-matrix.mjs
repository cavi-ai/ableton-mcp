import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadCategoryConfig } from "../src/artwork-categories.mjs";
import { buildArtworkMatrix } from "../src/artwork-matrix.mjs";
import {
  loadArtworkStore,
  mergeArtworkRecords,
  saveArtworkStore
} from "../src/artwork-store.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const manifestPath = resolve(workspaceRoot, "reports/nks/manifest.json");
const matrixPath = resolve(workspaceRoot, "reports/nks/artwork-matrix.json");
const categoryPath = resolve(workspaceRoot, "config/artwork/categories.json");
const productPath = resolve(workspaceRoot, "config/artwork/products.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const categoryConfig = loadCategoryConfig(categoryPath);
const productConfig = JSON.parse(readFileSync(productPath, "utf8"));
if (productConfig.version !== 1 || !Number.isInteger(productConfig.promptVersion)) {
  throw new Error("invalid artwork product config");
}

const built = buildArtworkMatrix(manifest.records, {
  categoryConfig,
  promptVersion: productConfig.promptVersion,
  productConfig
});
const prior = loadArtworkStore(matrixPath, {
  promptVersion: productConfig.promptVersion
});
const records = mergeArtworkRecords(prior.records, built.records);
const activeIds = new Set(built.records.map(({ id }) => id));
const store = {
  version: 1,
  promptVersion: productConfig.promptVersion,
  records: records.filter(({ id }) => activeIds.has(id)),
  assignments: built.assignments
};
saveArtworkStore(matrixPath, store);
console.log(`artwork records=${store.records.length} assignments=${store.assignments.length}`);
