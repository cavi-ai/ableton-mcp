import test from "node:test";
import assert from "node:assert/strict";
import { inventoryProduct } from "../src/inventory.mjs";

test("inventoryProduct preserves unchanged progress and restarts changed sources", async () => {
  const records = new Map([
    [
      "serum-2:fixed",
      {
        id: "serum-2:fixed",
        productSlug: "serum-2",
        sourceFingerprint: "sha256:old",
        state: "validated",
        evidence: []
      }
    ]
  ]);
  const store = {
    get: (id) => records.get(id),
    upsert: async (record) => records.set(record.id, record),
    flush: async () => {}
  };
  const indexed = [];
  const catalog = { upsert: (record) => indexed.push(record) };
  const discover = async () => [
    {
      productSlug: "serum-2",
      sourceRoot: "/root",
      sourcePath: "/root/Bass/Deep.fxp",
      name: "Deep",
      bank: "Factory",
      subBank: "Bass",
      types: ["Bass"],
      modes: [],
      author: "Xfer Records",
      sourceFingerprint: "sha256:new"
    }
  ];
  const result = await inventoryProduct({
    discover,
    store,
    catalog,
    idForDiscovery: () => "serum-2:fixed"
  });
  assert.deepEqual(result, { discovered: 1, unchanged: 0 });
  assert.equal(records.get("serum-2:fixed").state, "discovered");
  assert.equal(records.get("serum-2:fixed").evidence.at(-1).reason, "source_changed");
  assert.equal(indexed.length, 1);
});
