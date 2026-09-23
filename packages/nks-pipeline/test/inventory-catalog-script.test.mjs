import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Catalog } from "../src/catalog.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/inventory-catalog.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("fixtures/serum", import.meta.url));

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "nks-inventory-"));
  await cp(fixtures, join(root, "home", "serum"), { recursive: true });
  await mkdir(join(root, "plugins"));
  await writeFile(join(root, "plugins", "serum-2.json"), JSON.stringify({
    productSlug: "serum-2",
    vendor: "Xfer Records",
    product: "Serum 2",
    version: "2.1.4",
    format: "VST3",
    factoryRoots: ["~/serum"],
    extensions: [".fxp"],
    enabled: true
  }));
  await writeFile(join(root, "plugins", "disabled.json"), JSON.stringify({
    productSlug: "vps-avenger", factoryRoots: [], extensions: [], enabled: false
  }));
  return root;
}

function inventory(root) {
  return run(process.execPath, [
    script,
    "--config-dir", join(root, "plugins"),
    "--manifest", join(root, "out", "manifest.json"),
    "--catalog", join(root, "out", "catalog.sqlite")
  ], { env: { ...process.env, HOME: join(root, "home") } });
}

test("inventory-catalog writes the manifest and a searchable catalog from plugin configs", async () => {
  const root = await workspace();
  const first = await inventory(root);
  assert.equal(first.stdout.trim(), "serum-2 discovered=2 unchanged=0");

  const manifest = JSON.parse(await readFile(join(root, "out", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.records.map((record) => record.name).sort(), ["Bright", "Deep"]);

  const catalog = Catalog.open(join(root, "out", "catalog.sqlite"));
  try {
    assert.deepEqual(catalog.search({ productSlug: "serum-2" }).map((preset) => preset.name).sort(), ["Bright", "Deep"]);
  } finally {
    catalog.close();
  }

  const second = await inventory(root);
  assert.equal(second.stdout.trim(), "serum-2 discovered=0 unchanged=2");
});

test("inventory-catalog rejects an enabled product without a discovery adapter", async () => {
  const root = await workspace();
  await writeFile(join(root, "plugins", "unknown.json"), JSON.stringify({
    productSlug: "unknown-synth", factoryRoots: [], extensions: [], enabled: true
  }));
  await assert.rejects(inventory(root), /no discovery adapter for unknown-synth/);
});
