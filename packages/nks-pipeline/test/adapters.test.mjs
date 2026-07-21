import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSerumFactoryPresets } from "../src/adapters/serum-2.mjs";

test("Serum discovery returns visible FXP files with category metadata", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/serum");
  const results = await discoverSerumFactoryPresets({
    productSlug: "serum-2",
    vendor: "Xfer Records",
    product: "Serum 2",
    version: "2.1.4",
    format: "VST3",
    factoryRoots: [root],
    extensions: [".fxp"],
    enabled: true
  });
  assert.deepEqual(results.map((item) => item.name), ["Deep", "Bright"]);
  assert.deepEqual(results.map((item) => item.subBank), ["Bass", "Leads"]);
  assert.equal(results.every((item) => item.sourceFingerprint.startsWith("sha256:")), true);
});
