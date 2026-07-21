import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { buildContactSheet } from "../src/artwork-contact-sheet.mjs";
import { loadArtworkStore } from "../src/artwork-store.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const productSlug = option("--product", "serum-2");
const bank = option("--bank", "");
const pageSize = Number(option("--page-size", "100"));
if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("page size must be positive");
const products = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/products.json"), "utf8")
);
const matrix = loadArtworkStore(
  resolve(workspaceRoot, "reports/nks/artwork-matrix.json"),
  { promptVersion: products.promptVersion }
);
const variants = matrix.records
  .filter(
    (record) =>
      record.level === "variant" &&
      record.productSlug === productSlug &&
      record.path &&
      (!bank || record.subBank === bank || record.bank === bank)
  )
  .sort((left, right) =>
    left.library.localeCompare(right.library) ||
    left.subBank.localeCompare(right.subBank) ||
    left.category.localeCompare(right.category) ||
    left.id.localeCompare(right.id)
  );
if (variants.length === 0) throw new Error("no rendered variants matched contact-sheet selection");
const suffix = bank ? `-${bank.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "";
const pages = [];
for (let offset = 0; offset < variants.length; offset += pageSize) {
  const page = variants.slice(offset, offset + pageSize);
  const pageSuffix = variants.length > pageSize
    ? `-page-${String(pages.length + 1).padStart(3, "0")}`
    : "";
  const outputPath = resolve(
    workspaceRoot,
    "reports/nks/artwork-contact-sheets",
    `${productSlug}${suffix}${pageSuffix}.png`
  );
  pages.push(buildContactSheet(
    page.map((record) => resolve(workspaceRoot, record.path)),
    outputPath,
    { columns: 5, tileWidth: 240, tileHeight: 240, gap: 8, background: "#080b14" }
  ));
}
console.log(`contact sheets=${pages.length} artwork=${variants.length}`);
for (const page of pages) console.log(page.path);
