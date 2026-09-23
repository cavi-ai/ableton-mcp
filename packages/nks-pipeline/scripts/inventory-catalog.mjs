import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverOmnisphereFactoryPresets } from "../src/adapters/omnisphere.mjs";
import { discoverSerumFactoryPresets } from "../src/adapters/serum-2.mjs";
import { Catalog } from "../src/catalog.mjs";
import { inventoryProduct } from "../src/inventory.mjs";
import { ManifestStore } from "../src/manifest-store.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

const adapters = {
  "serum-2": discoverSerumFactoryPresets,
  omnisphere: discoverOmnisphereFactoryPresets
};

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "../..");
const configDirectory = resolve(option("--config-dir", resolve(workspaceRoot, "config/plugins")));
const manifestPath = resolve(option("--manifest", resolve(workspaceRoot, "reports/nks/manifest.json")));
const catalogPath = resolve(option("--catalog", resolve(workspaceRoot, "reports/nks/catalog.sqlite")));
const productSlug = option("--product", undefined);

const configs = readdirSync(configDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(configDirectory, name), "utf8")))
  .filter((config) => config.enabled && (!productSlug || config.productSlug === productSlug));
if (productSlug && configs.length === 0) throw new Error(`no enabled product matches --product ${productSlug}`);
for (const config of configs) {
  if (!adapters[config.productSlug]) throw new Error(`no discovery adapter for ${config.productSlug}`);
}

mkdirSync(dirname(catalogPath), { recursive: true });
const store = await ManifestStore.open(manifestPath);
const catalog = Catalog.open(catalogPath);
try {
  for (const config of configs) {
    const factoryRoots = config.factoryRoots.map(expandHome);
    const discoveries = await adapters[config.productSlug]({ ...config, factoryRoots });
    catalog.database.exec("BEGIN");
    let result;
    try {
      result = await inventoryProduct({ discover: async () => discoveries, store, catalog });
      catalog.database.exec("COMMIT");
    } catch (error) {
      catalog.database.exec("ROLLBACK");
      throw error;
    }
    const { discovered, unchanged } = result;
    console.log(`${config.productSlug} discovered=${discovered} unchanged=${unchanged}`);
  }
} finally {
  catalog.close();
}
