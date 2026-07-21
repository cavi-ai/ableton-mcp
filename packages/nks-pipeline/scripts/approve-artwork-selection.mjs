import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { approveArtworkSelection } from "../src/artwork-review.mjs";
import { loadArtworkStore, saveArtworkStore } from "../src/artwork-store.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const productSlug = option("--product", "serum-2");
const bank = option("--bank", "");
const products = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/products.json"), "utf8")
);
const matrixPath = resolve(workspaceRoot, "reports/nks/artwork-matrix.json");
const reviewPath = resolve(workspaceRoot, "reports/nks/artwork-review.json");
const matrix = loadArtworkStore(matrixPath, { promptVersion: products.promptVersion });
const result = approveArtworkSelection(matrix.records, {
  productSlug,
  bank,
  reviewer: "operator",
  notes: "Full-size and thumbnail review passed; integrated symbols remain legible without badges or text"
});
if (result.decisions.length === 0) throw new Error("no validated artwork matched approval selection");
const existing = existsSync(reviewPath)
  ? JSON.parse(readFileSync(reviewPath, "utf8"))
  : { version: 1, promptVersion: products.promptVersion, records: [] };
const decisions = new Map(existing.records.map((record) => [record.artworkId, record]));
for (const decision of result.decisions) decisions.set(decision.artworkId, decision);
saveArtworkStore(matrixPath, { ...matrix, records: result.records });
writeFileSync(
  reviewPath,
  `${JSON.stringify({
    version: 1,
    promptVersion: products.promptVersion,
    records: [...decisions.values()].sort((left, right) => left.artworkId.localeCompare(right.artworkId))
  }, null, 2)}\n`
);
console.log(`approved artwork=${result.decisions.length}`);
