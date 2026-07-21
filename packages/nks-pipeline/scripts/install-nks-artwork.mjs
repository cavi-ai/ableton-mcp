import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyInstallPlan, buildInstallPlan } from "../src/artwork-packager.mjs";
import { renderDerivatives } from "../src/artwork-renderer.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const targetRoot = resolve(option("--target", "/Users/Shared/NI Resources/image"));
if (targetRoot !== "/Users/Shared/NI Resources/image") {
  throw new Error(`unapproved Native Instruments image target: ${targetRoot}`);
}
const apply = process.argv.includes("--apply");
const products = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/products.json"), "utf8")
);
const derivatives = JSON.parse(
  readFileSync(resolve(workspaceRoot, "config/artwork/derivatives.json"), "utf8")
);
const stageRoot = resolve(workspaceRoot, "artwork/nks/staging/ni-image");

for (const [productSlug, product] of Object.entries(products.products)) {
  const productRoot = resolve(stageRoot, product.nativeImageKey);
  mkdirSync(productRoot, { recursive: true });
  renderDerivatives({
    inputPath: resolve(workspaceRoot, product.productMasterPath),
    outputRoot: productRoot,
    policy: derivatives
  });
  writeFileSync(
    resolve(productRoot, `${product.nativeImageKey}.meta`),
    `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n<resource version="2.3989.0.0">\n\n  <name>${product.displayName}</name>\n\n  <type>image</type>\n\n</resource>\n`
  );
  console.log(`staged ${productSlug} as ${product.nativeImageKey}`);
}

const plan = buildInstallPlan({ stageRoot, targetRoot });
console.log(`install dryRun=${!apply} copies=${plan.copies.length} skipped=${plan.skipped.length} errors=${plan.errors.length}`);
const result = applyInstallPlan(plan, { apply });
console.log(JSON.stringify(result));
