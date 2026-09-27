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
    sourcePath: `/factory/Factory/Bass/${id}.fxp`, sourceRelativePath: `Factory/Bass/${id}.fxp`,
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
    sourceRelativePath: "Factory/Bass/serum-2:a.fxp",
    state: "nks_saved", evidence: [{ state: "nks_saved", artifact: { sha256: "abc" } }] });
  assert.throws(() => queue.completeSaved("serum-2:a", "worker-b", 1103), /verified artifact evidence/);
  catalog.upsert({ id: "serum-2:a", productSlug: "serum-2", name: "serum-2:a", bank: "Factory",
    subBank: "Bass", author: "Xfer Records", sourceFingerprint: "sha256:serum-2:a",
    sourceRelativePath: "Factory/Bass/serum-2:a.fxp",
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

test("Serum queue cannot enqueue outside the deterministic pilot until every pilot preset is validated", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "nks-pilot-gate-")), "catalog.sqlite");
  const catalog = Catalog.open(path);
  const records = Array.from({ length: 30 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return { id: `serum-2:${suffix}`, productSlug: "serum-2", name: `Preset ${suffix}`,
      sourcePath: `/factory/Factory/Bass/Preset ${suffix}.fxp`,
      sourceRelativePath: `Factory/Bass/Preset ${suffix}.fxp`, bank: "Factory", subBank: "Bass",
      author: "Xfer Records", sourceFingerprint: `sha256:${suffix}`, state: "discovered", evidence: [] };
  });
  for (const record of records) catalog.upsert(record);
  const outside = "serum-2:24";
  assert.deepEqual(GenerationQueue.inspect(path, "serum-2").pilot,
    { total: 25, validated: 0, gateOpen: false, queueable: 25,
      remainingPilotPresetIds: [...records.slice(0, 24), records[29]].map(record => record.id),
      unqueuedPilotPresetIds: [...records.slice(0, 24), records[29]].map(record => record.id) });
  assert.throws(() => GenerationQueue.inspectSelection(path, "serum-2", [outside]), /pilot/);
  const queue = GenerationQueue.open(path);
  assert.throws(() => queue.enqueue("serum-2", [outside]), /pilot/);
  assert.equal(queue.get(outside), undefined);
  queue.database.prepare(`INSERT INTO nks_generation_jobs
    (preset_id, source_fingerprint, status, attempts) VALUES (?, ?, 'pending', 0)`)
    .run(outside, "sha256:24");
  assert.equal(queue.claim("worker-a", "serum-2", 1000), undefined);
  assert.equal(queue.claim("worker-a", undefined, 1000), undefined);
  assert.equal(queue.claim("worker-a", null, 1000), undefined);
  queue.database.prepare("DELETE FROM nks_generation_jobs WHERE preset_id = ?").run(outside);
  assert.equal(queue.enqueue("serum-2", ["serum-2:00"]), 1);
  assert.deepEqual(GenerationQueue.inspect(path, "serum-2").pilot.unqueuedPilotPresetIds,
    [...records.slice(1, 24), records[29]].map(record => record.id));
  for (const record of records.filter(({ id }) => id !== outside && !["serum-2:25", "serum-2:26", "serum-2:27", "serum-2:28"].includes(id)))
    catalog.upsert({ ...record, state: "validated", evidence: [{ state: "validated" }] });
  assert.equal(GenerationQueue.inspect(path, "serum-2").pilot.gateOpen, false);
  for (const record of records.filter(({ id }) => id !== outside && !["serum-2:25", "serum-2:26", "serum-2:27", "serum-2:28"].includes(id)))
    catalog.upsert({ ...record, state: "validated", evidence: [{ state: "validated",
      kind: "operator_reported_recall_controller_verified", reportSha256: "a".repeat(64),
      controllerControlCount: 8, recall: { evidence: { sha256: "b".repeat(64) } },
      controller: { evidence: { sha256: "c".repeat(64) } } }] });
  assert.deepEqual(GenerationQueue.inspect(path, "serum-2").pilot,
    { total: 25, validated: 25, gateOpen: true, queueable: 5, remainingPilotPresetIds: [],
      unqueuedPilotPresetIds: [] });
  assert.equal(GenerationQueue.inspectSelection(path, "serum-2", [outside]).eligible, 1);
  assert.equal(queue.enqueue("serum-2", [outside]), 1);
  assert.equal(queue.claim("worker-a", "serum-2", 1001).presetId, outside);
  queue.close();
  catalog.close();
});

test("Serum queue never treats User-source presets as factory jobs", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "nks-factory-only-")), "catalog.sqlite");
  const catalog = Catalog.open(path);
  const base = { productSlug: "serum-2", bank: "Factory", subBank: "Bass",
    author: "Xfer Records", state: "discovered", evidence: [] };
  catalog.upsert({ ...base, id: "serum-2:factory", name: "Factory",
    sourcePath: "/factory/Factory/Bass/Factory.fxp", sourceRelativePath: "Factory/Bass/Factory.fxp",
    sourceFingerprint: "sha256:factory", state: "validated", evidence: [{ state: "validated",
      kind: "operator_reported_recall_controller_verified", reportSha256: "a".repeat(64), controllerControlCount: 8,
      recall: { evidence: { sha256: "b".repeat(64) } }, controller: { evidence: { sha256: "c".repeat(64) } } }] });
  catalog.upsert({ ...base, id: "serum-2:user", name: "Personal",
    sourcePath: "/factory/User/Personal.fxp", sourceRelativePath: "User/Personal.fxp",
    sourceFingerprint: "sha256:user" });
  assert.throws(() => GenerationQueue.inspectSelection(path, "serum-2", ["serum-2:user"]), /User.*factory/);
  const queue = GenerationQueue.open(path);
  assert.throws(() => queue.enqueue("serum-2", ["serum-2:user"]), /User.*factory/);
  assert.equal(queue.get("serum-2:user"), undefined);
  queue.database.prepare(`INSERT INTO nks_generation_jobs
    (preset_id, source_fingerprint, status, attempts) VALUES (?, ?, 'pending', 0)`)
    .run("serum-2:user", "sha256:user");
  assert.equal(queue.claim("worker-a", "serum-2", 1000), undefined);
  queue.close();
  catalog.close();
});

test("Omnisphere queue limits legacy and new jobs to its source-derived pilot until validation", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "nks-omni-pilot-gate-")), "catalog.sqlite");
  const catalog = Catalog.open(path);
  const records = Array.from({ length: 30 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return { id: `omnisphere:${suffix}`, productSlug: "omnisphere", name: `Preset ${suffix}`,
      bank: "Factory", subBank: "Pads", sourcePath: `/factory/Factory.db/Preset ${suffix}.prt_omn`,
      sourceRelativePath: `Factory.db/Preset ${suffix}.prt_omn`,
      sourceContainerPath: "/factory/Factory.db", sourceEntryName: `Pads/Preset ${suffix}.prt_omn`,
      author: "Spectrasonics", sourceFingerprint: `sha256:${suffix}`, state: "discovered", evidence: [] };
  });
  for (const record of records) catalog.upsert(record);
  const user = { ...records[0], id: "omnisphere:user", name: "Personal",
    sourcePath: "/factory/Factory.db/Personal.prt_omn",
    sourceRelativePath: "Factory.db/Personal.prt_omn", sourceEntryName: "User/Personal.prt_omn",
    sourceFingerprint: "sha256:user" };
  catalog.upsert(user);
  const outside = "omnisphere:24";
  assert.deepEqual(GenerationQueue.inspect(path, "omnisphere").pilot,
    { total: 25, validated: 0, gateOpen: false, queueable: 25,
      remainingPilotPresetIds: [...records.slice(0, 24), records[29]].map(record => record.id),
      unqueuedPilotPresetIds: [...records.slice(0, 24), records[29]].map(record => record.id) });
  assert.throws(() => GenerationQueue.inspectSelection(path, "omnisphere", [outside]), /pilot/);
  assert.throws(() => GenerationQueue.inspectSelection(path, "omnisphere", [user.id]), /User.*factory/);
  const queue = GenerationQueue.open(path);
  queue.database.prepare(`INSERT INTO nks_generation_jobs
    (preset_id, source_fingerprint, status, attempts) VALUES (?, ?, 'pending', 0)`)
    .run(outside, "sha256:24");
  assert.equal(queue.claim("worker-a", "omnisphere", 1000), undefined);
  assert.equal(queue.claim("worker-a", null, 1000), undefined);
  queue.database.prepare("DELETE FROM nks_generation_jobs WHERE preset_id = ?").run(outside);
  assert.equal(queue.enqueue("omnisphere", [records[0].id]), 1);
  for (const record of records.filter((_, index) => index < 24 || index === 29))
    catalog.upsert({ ...record, state: "validated", evidence: [{ state: "validated",
      kind: "operator_reported_recall_controller_verified", reportSha256: "a".repeat(64),
      controllerControlCount: 8, recall: { evidence: { sha256: "b".repeat(64) } },
      controller: { evidence: { sha256: "c".repeat(64) } } }] });
  assert.deepEqual(GenerationQueue.inspect(path, "omnisphere").pilot,
    { total: 25, validated: 25, gateOpen: true, queueable: 5, remainingPilotPresetIds: [],
      unqueuedPilotPresetIds: [] });
  assert.equal(queue.enqueue("omnisphere", [outside]), 1);
  assert.throws(() => queue.enqueue("omnisphere", [user.id]), /User.*factory/);
  assert.equal(queue.claim("worker-a", "omnisphere", 1001).presetId, outside);
  queue.close();
  catalog.close();
});

test("unconfigured product names cannot inherit a pilot policy from object prototypes", async () => {
  const path = await fixture();
  assert.equal(GenerationQueue.inspect(path, "toString").pilot, undefined);
});
