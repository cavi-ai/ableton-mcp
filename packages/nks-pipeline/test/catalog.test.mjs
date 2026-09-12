import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Catalog } from "../src/catalog.mjs";

test("Catalog upserts and searches presets with deterministic export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nks-catalog-"));
  const catalog = Catalog.open(join(dir, "catalog.sqlite"));
  catalog.upsert({
    id: "serum-2:b",
    productSlug: "serum-2",
    name: "Bright",
    bank: "Factory",
    subBank: "Leads",
    types: ["Lead"],
    modes: [],
    author: "Xfer Records",
    sourceFingerprint: "sha256:b",
    state: "indexed",
    evidence: []
  });
  catalog.upsert({
    id: "serum-2:a",
    productSlug: "serum-2",
    name: "Deep",
    bank: "Factory",
    subBank: "Bass",
    types: ["Bass"],
    modes: [],
    author: "Xfer Records",
    sourceFingerprint: "sha256:a",
    state: "indexed",
    evidence: []
  });
  assert.deepEqual(
    catalog.search({ productSlug: "serum-2", query: "deep" }).map((item) => item.id),
    ["serum-2:a"]
  );
  assert.deepEqual(JSON.parse(catalog.exportJson()).records.map((item) => item.id), [
    "serum-2:a",
    "serum-2:b"
  ]);
  catalog.close();
});

test("Catalog stores approved artwork and one assignment per preset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nks-catalog-artwork-"));
  const catalog = Catalog.open(join(dir, "catalog.sqlite"));
  catalog.upsert({
    id: "serum-2:a",
    productSlug: "serum-2",
    name: "Deep",
    bank: "Factory",
    subBank: "Bass",
    author: "Xfer Records",
    sourceFingerprint: "sha256:a",
    state: "validated"
  });
  const artwork = {
    id: "art:bass",
    productSlug: "serum-2",
    category: "bass",
    state: "approved",
    path: "artwork/nks/variants/serum-2/art-bass.png",
    derivatives: [{ name: "NKS2_software_tile", path: "tile.webp" }]
  };
  catalog.upsertArtwork(artwork);
  catalog.assignArtwork("serum-2:a", "art:bass");
  assert.equal(catalog.get("serum-2:a").artworkId, "art:bass");
  assert.deepEqual(catalog.getArtwork("art:bass"), artwork);
  assert.equal(catalog.artworkForPreset("serum-2:a").id, "art:bass");
  assert.equal(JSON.parse(catalog.exportJson()).records[0].artworkId, "art:bass");
  catalog.close();
});

test("Catalog rejects unapproved or missing artwork assignments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nks-catalog-artwork-invalid-"));
  const catalog = Catalog.open(join(dir, "catalog.sqlite"));
  catalog.upsert({
    id: "serum-2:a",
    productSlug: "serum-2",
    name: "Deep",
    bank: "Factory",
    subBank: "Bass",
    author: "Xfer Records",
    sourceFingerprint: "sha256:a",
    state: "validated"
  });
  catalog.upsertArtwork({
    id: "art:pending",
    productSlug: "serum-2",
    category: "bass",
    state: "validated"
  });
  assert.throws(() => catalog.assignArtwork("serum-2:a", "art:pending"), /artwork is not approved/);
  assert.throws(() => catalog.assignArtwork("serum-2:a", "art:missing"), /unknown artwork/);
  assert.throws(() => catalog.assignArtwork("missing", "art:pending"), /unknown preset/);
  catalog.close();
});

test("Catalog persists normalized user tags and favorites outside vendor preset JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nks-catalog-metadata-"));
  const path = join(dir, "catalog.sqlite");
  let catalog = Catalog.open(path);
  catalog.upsert({
    id: "serum-2:a", productSlug: "serum-2", name: "Deep", bank: "Factory", subBank: "Bass",
    author: "Xfer Records", sourceFingerprint: "sha256:a", state: "indexed", types: ["Bass"]
  });
  assert.deepEqual(catalog.metadata("serum-2:a"), { favorite: false, tags: [], revision: 0 });
  assert.deepEqual(catalog.setMetadata("serum-2:a", 0, {
    favorite: true, tags: [" Warm ", "bass", "WARM"]
  }), { favorite: true, tags: ["bass", "warm"], revision: 1 });
  assert.equal(JSON.parse(catalog.database.prepare("SELECT json FROM presets WHERE id = ?").get("serum-2:a").json).metadata, undefined);
  catalog.close();

  catalog = Catalog.open(path);
  assert.deepEqual(catalog.metadata("serum-2:a"), { favorite: true, tags: ["bass", "warm"], revision: 1 });
  assert.deepEqual(catalog.search({ productSlug: "serum-2", favorite: true, tags: ["warm"] })[0].metadata,
    { favorite: true, tags: ["bass", "warm"], revision: 1 });
  assert.equal(catalog.search({ productSlug: "serum-2", favorite: false }).length, 0);
  assert.deepEqual(JSON.parse(catalog.exportJson()).records[0].metadata,
    { favorite: true, tags: ["bass", "warm"], revision: 1 });
  catalog.close();
});

test("Catalog rejects stale preset metadata revisions and unknown presets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nks-catalog-metadata-guard-"));
  const catalog = Catalog.open(join(dir, "catalog.sqlite"));
  catalog.upsert({
    id: "serum-2:a", productSlug: "serum-2", name: "Deep", bank: "Factory", subBank: "Bass",
    author: "Xfer Records", sourceFingerprint: "sha256:a", state: "indexed"
  });
  catalog.setMetadata("serum-2:a", 0, { favorite: true });
  assert.throws(() => catalog.setMetadata("serum-2:a", 0, { tags: ["warm"] }), /metadata revision mismatch/);
  assert.throws(() => catalog.metadata("missing"), /unknown preset missing/);
  catalog.close();
});
