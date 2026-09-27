import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "../src/catalog.mjs";
import { GenerationQueue } from "../src/generation-queue.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nks-queue-"));
  const path = join(directory, "catalog.sqlite");
  const catalog = Catalog.open(path);
  for (const id of ["serum-2:b", "serum-2:a"]) catalog.upsert({
    id, productSlug: "serum-2", name: id, bank: "Factory", subBank: "Bass",
    author: "Xfer Records", sourceFingerprint: `sha256:${id}`, state: "discovered", evidence: []
  });
  catalog.close();
  return path;
}

test("generation queue persists deterministic leases across processes and prevents duplicate claims", async () => {
  const path = await fixture();
  let first = GenerationQueue.open(path, { leaseMs: 100, maxAttempts: 2 });
  assert.equal(first.enqueue("serum-2", ["serum-2:a", "serum-2:b"]), 2);
  assert.equal(first.claim("worker-a", "serum-2", 1000).presetId, "serum-2:a");
  first.close();
  const second = GenerationQueue.open(path, { leaseMs: 100, maxAttempts: 2 });
  assert.equal(second.claim("worker-b", "serum-2", 1001).presetId, "serum-2:b");
  assert.equal(second.claim("worker-c", "serum-2", 1002), undefined);
  assert.equal(second.heartbeat("serum-2:a", "worker-a", 1050).leaseExpiresAt, 1150);
  assert.throws(() => second.heartbeat("serum-2:a", "worker-b", 1051), /not leased/);
  second.close();
});

test("generation queue retries stale leases, quarantines exhausted attempts and gates completion on catalog evidence", async () => {
  const path = await fixture();
  const queue = GenerationQueue.open(path, { leaseMs: 100, maxAttempts: 2 });
  queue.enqueue("serum-2", ["serum-2:a", "serum-2:b"]);
  assert.equal(queue.claim("worker-a", "serum-2", 1000).attempts, 1);
  assert.equal(queue.claim("worker-b", "serum-2", 1101).presetId, "serum-2:a");
  assert.throws(() => queue.completeSaved("serum-2:a", "worker-b", 1102), /not nks_saved/);
  const catalog = Catalog.open(path);
  catalog.upsert({ id: "serum-2:a", productSlug: "serum-2", name: "serum-2:a", bank: "Factory",
    subBank: "Bass", author: "Xfer Records", sourceFingerprint: "sha256:serum-2:a",
    state: "nks_saved", evidence: [{ state: "nks_saved", artifact: { sha256: "abc" } }] });
  assert.throws(() => queue.completeSaved("serum-2:a", "worker-b", 1103), /verified artifact evidence/);
  catalog.upsert({ id: "serum-2:a", productSlug: "serum-2", name: "serum-2:a", bank: "Factory",
    subBank: "Bass", author: "Xfer Records", sourceFingerprint: "sha256:serum-2:a",
    state: "nks_saved", evidence: [{ state: "nks_saved", kind: "komplete_index_and_file_verified",
      artifact: { sha256: "a".repeat(64) } }] });
  catalog.close();
  assert.equal(queue.completeSaved("serum-2:a", "worker-b", 1103).status, "done");
  assert.equal(queue.claim("worker-c", "serum-2", 1104).presetId, "serum-2:b");
  assert.equal(queue.fail("serum-2:b", "worker-c", "load_failed", 1105).status, "pending");
  queue.claim("worker-c", "serum-2", 1106);
  assert.equal(queue.fail("serum-2:b", "worker-c", "load_failed", 1107).status, "quarantined");
  queue.close();
  const reopened = GenerationQueue.open(path, { leaseMs: 100, maxAttempts: 2 });
  assert.deepEqual(reopened.counts(), { done: 1, quarantined: 1 });
  assert.deepEqual(reopened.events("serum-2:a").map(event => event.kind), ["leased", "stale_lease", "leased", "done"]);
  assert.deepEqual(reopened.events("serum-2:b").map(event => event.kind), ["leased", "failed", "leased", "quarantined"]);
  reopened.close();
});
