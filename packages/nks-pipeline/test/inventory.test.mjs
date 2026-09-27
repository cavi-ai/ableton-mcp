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
    list: (productSlug) => [...records.values()].filter((record) => record.productSlug === productSlug),
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
    productSlug: "serum-2",
    discover,
    store,
    catalog,
    idForDiscovery: () => "serum-2:fixed"
  });
  assert.deepEqual(result, { discovered: 1, unchanged: 0, missing: 0 });
  assert.equal(records.get("serum-2:fixed").state, "discovered");
  assert.equal(records.get("serum-2:fixed").evidence.at(-1).reason, "source_changed");
  assert.equal(indexed.length, 1);
});

test("inventoryProduct marks presets it did not rediscover as missing and restores them when they return", async () => {
  const records = new Map();
  const store = {
    get: (id) => records.get(id),
    upsert: async (record) => records.set(record.id, record),
    list: (productSlug) => [...records.values()].filter((record) => record.productSlug === productSlug),
    flush: async () => {}
  };
  const indexed = [];
  const catalog = { upsert: (record) => indexed.push(record) };
  const discovery = (name) => ({ productSlug: "serum-2", sourceRoot: "/root", sourcePath: `/root/Bass/${name}.fxp`, name,
    bank: "Factory", subBank: "Bass", types: ["Bass"], modes: [], author: "Xfer Records", sourceFingerprint: `sha256:${name}` });
  const run = (names) => inventoryProduct({ productSlug: "serum-2", discover: async () => names.map(discovery), store, catalog });

  assert.deepEqual(await run(["Deep", "Wide"]), { discovered: 2, unchanged: 0, missing: 0 });
  assert.deepEqual(await run(["Deep"]), { discovered: 0, unchanged: 1, missing: 1 });
  const wide = [...records.values()].find((record) => record.name === "Wide");
  assert.equal(wide.missing, true);
  assert.equal(wide.state, "discovered");
  assert.equal(indexed.at(-1).missing, true);

  assert.deepEqual(await run(["Deep", "Wide"]), { discovered: 0, unchanged: 2, missing: 0 });
  assert.equal(records.get(wide.id).missing, undefined);
});

test("inventoryProduct refreshes source metadata without resetting unchanged preset progress", async () => {
  const existing = { id: "omnisphere:fixed", productSlug: "omnisphere", name: "Shared", bank: "Factory",
    subBank: "Factory", types: ["Factory"], modes: [], author: "Spectrasonics", sourceRoot: "/root",
    sourcePath: "/root/Factory.db/Shared.prt_omn", sourceRelativePath: "Factory.db/Shared.prt_omn",
    sourceContainerPath: "/root/Factory.db", sourceEntryName: "Shared.prt_omn",
    sourceFingerprint: "sha256:same", state: "validated", attempts: 2,
    evidence: [{ state: "validated", kind: "verified" }] };
  const records = new Map([[existing.id, existing]]);
  const store = { get: id => records.get(id), upsert: async record => records.set(record.id, record),
    list: slug => [...records.values()].filter(record => record.productSlug === slug), flush: async () => {} };
  const indexed = [];
  const discovery = { productSlug: "omnisphere", sourceRoot: "/root", sourcePath: existing.sourcePath,
    sourceContainerPath: existing.sourceContainerPath, sourceEntryName: "Pads/Shared.prt_omn",
    name: "Shared", bank: "Factory", subBank: "Pads", types: ["Pads"], modes: [],
    author: "Spectrasonics", sourceFingerprint: "sha256:same" };
  assert.deepEqual(await inventoryProduct({ productSlug: "omnisphere", discover: async () => [discovery],
    store, catalog: { upsert: record => indexed.push(record) }, idForDiscovery: () => existing.id }),
  { discovered: 0, unchanged: 1, missing: 0 });
  assert.equal(records.get(existing.id).subBank, "Pads");
  assert.equal(records.get(existing.id).sourceEntryName, "Pads/Shared.prt_omn");
  assert.deepEqual(records.get(existing.id).types, ["Pads"]);
  assert.equal(records.get(existing.id).state, "validated");
  assert.deepEqual(records.get(existing.id).evidence, existing.evidence);
  assert.equal(indexed[0].subBank, "Pads");
});
