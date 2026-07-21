import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Catalog } from "../src/catalog.mjs";
import { loadArtworkStore } from "../src/artwork-store.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const products = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/products.json"), "utf8")
);
const matrix = loadArtworkStore(
  resolve(workspaceRoot, "reports/nks/artwork-matrix.json"),
  { promptVersion: products.promptVersion }
);
const catalog = Catalog.open(resolve(workspaceRoot, "reports/nks/catalog.sqlite"));
try {
  for (const artwork of matrix.records) {
    if (artwork.state !== "approved") {
      throw new Error(`artwork ${artwork.id} is not approved`);
    }
    catalog.upsertArtwork(artwork);
  }
  for (const assignment of matrix.assignments) {
    catalog.assignArtwork(assignment.presetId, assignment.artworkId);
  }
  const missing = matrix.assignments.filter(
    ({ presetId, artworkId }) => catalog.get(presetId)?.artworkId !== artworkId
  );
  if (missing.length > 0) throw new Error(`catalog artwork verification failed for ${missing.length} presets`);
  console.log(`catalog artwork=${matrix.records.length} assignments=${matrix.assignments.length}`);
} finally {
  catalog.close();
}
