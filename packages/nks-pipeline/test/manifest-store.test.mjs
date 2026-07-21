import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManifestStore } from "../src/manifest-store.mjs";

test("ManifestStore atomically persists sorted records and resumes pending work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nks-manifest-"));
  const path = join(dir, "manifest.json");
  const store = await ManifestStore.open(path);
  await store.upsert({ id: "serum-2:b", productSlug: "serum-2", state: "validated" });
  await store.upsert({ id: "serum-2:a", productSlug: "serum-2", state: "discovered" });
  await store.flush();
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.records.map((item) => item.id), ["serum-2:a", "serum-2:b"]);
  const reopened = await ManifestStore.open(path);
  assert.deepEqual(reopened.pending("serum-2").map((item) => item.id), ["serum-2:a"]);
});
