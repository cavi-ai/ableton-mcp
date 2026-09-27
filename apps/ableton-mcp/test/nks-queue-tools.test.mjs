import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { GenerationQueue } from "../../../packages/nks-pipeline/src/generation-queue.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";

test("NKS queue status is read-only and enqueue needs a current single-use confirmation", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "nks-mcp-queue-")), "catalog.sqlite");
  const catalog = Catalog.open(path);
  catalog.upsert({ id: "serum-2:a", productSlug: "serum-2", name: "A", bank: "Factory",
    subBank: "Bass", author: "Xfer", sourceFingerprint: "sha256:a", state: "discovered", evidence: [] });
  catalog.close();
  const service = new ToolService({ catalog: Catalog.open(path), generationQueuePath: path });
  const initial = await service.call("get_nks_generation_status", { productSlug: "serum-2" });
  assert.equal(initial.eligible, 1);
  assert.deepEqual(initial.jobs, {});
  assert.equal(initial.initialized, false);
  assert.deepEqual(await service.call("get_nks_generation_job", { presetId: "serum-2:a" }),
    { job: null, events: [] });
  await assert.rejects(service.call("claim_nks_generation_job", { workerId: "worker-a", productSlug: " " }),
    /productSlug is required/);
  assert.equal((await service.call("get_nks_generation_status", { productSlug: "serum-2" })).initialized, false);
  const plan = await service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2" });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.plan.eligible, 1);
  assert.deepEqual((await service.call("get_nks_generation_status", { productSlug: "serum-2" })).jobs, {});
  await assert.rejects(service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2", dryRun: false }), /confirmation/);
  const applied = await service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2", dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
  assert.equal(applied.enqueued, 1);
  assert.deepEqual((await service.call("get_nks_generation_status", { productSlug: "serum-2" })).jobs, { pending: 1 });
  await assert.rejects(service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2", dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }), /confirmation/);
});

test("NKS enqueue refuses a stale catalog plan and never marks presets saved", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "nks-mcp-queue-")), "catalog.sqlite");
  const catalog = Catalog.open(path);
  const record = { id: "serum-2:a", productSlug: "serum-2", name: "A", bank: "Factory",
    subBank: "Bass", author: "Xfer", sourceFingerprint: "sha256:a", state: "discovered", evidence: [] };
  catalog.upsert(record);
  const service = new ToolService({ catalog, generationQueuePath: path });
  const plan = await service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2" });
  catalog.upsert({ ...record, sourceFingerprint: "sha256:b" });
  await assert.rejects(service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2", dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }), /plan hash mismatch/);
  assert.equal(GenerationQueue.inspect(path, "serum-2").initialized, false);
  assert.equal(catalog.get(record.id).state, "discovered");
  catalog.close();
});

test("MCP worker tools lease, renew, retry, and complete only with verified catalog evidence", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "nks-mcp-worker-")), "catalog.sqlite");
  const catalog = Catalog.open(path);
  const record = { id: "serum-2:a", productSlug: "serum-2", name: "A", bank: "Factory",
    subBank: "Bass", author: "Xfer", sourceFingerprint: "sha256:a", state: "discovered", evidence: [] };
  catalog.upsert(record);
  const service = new ToolService({ catalog, generationQueuePath: path });
  const plan = await service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2" });
  await service.call("enqueue_nks_generation_jobs", { productSlug: "serum-2", dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash });
  const route = createRouter(service);
  const call = async (name, args) => (await route({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args } })).result;

  const lease = await call("claim_nks_generation_job", { workerId: "worker-a", productSlug: "serum-2" });
  assert.equal(lease.structuredContent.job.presetId, record.id);
  assert.equal(lease.structuredContent.job.status, "leased");
  assert.equal(lease.structuredContent.preset.state, "discovered");
  assert.equal((await call("claim_nks_generation_job", { workerId: "worker-b", productSlug: "serum-2" }))
    .structuredContent.job, null);
  assert.equal((await call("heartbeat_nks_generation_job", { presetId: record.id, workerId: "worker-b" })).isError, true);
  assert.equal((await call("heartbeat_nks_generation_job", { presetId: record.id, workerId: "worker-a" }))
    .structuredContent.job.workerId, "worker-a");
  assert.equal((await call("complete_nks_generation_job", { presetId: record.id, workerId: "worker-a" })).isError, true);
  assert.equal(catalog.get(record.id).state, "discovered");
  assert.equal((await call("fail_nks_generation_job", { presetId: record.id, workerId: "worker-a",
    reason: "save_failed" })).structuredContent.job.status, "pending");
  const retry = await call("claim_nks_generation_job", { workerId: "worker-b", productSlug: "serum-2" });
  assert.equal(retry.structuredContent.job.attempts, 2);
  catalog.upsert({ ...record, state: "nks_saved", evidence: [{ state: "nks_saved",
    kind: "komplete_index_and_file_verified", artifact: { sha256: "a".repeat(64) } }] });
  assert.equal((await call("complete_nks_generation_job", { presetId: record.id, workerId: "worker-a" })).isError, true);
  assert.equal((await call("complete_nks_generation_job", { presetId: record.id, workerId: "worker-b" }))
    .structuredContent.job.status, "done");
  const inspected = await call("get_nks_generation_job", { presetId: record.id });
  assert.equal(inspected.structuredContent.job.status, "done");
  assert.deepEqual(inspected.structuredContent.events.map(({ kind }) => kind),
    ["leased", "heartbeat", "failed", "leased", "done"]);
  assert.deepEqual((await service.call("get_nks_generation_status", { productSlug: "serum-2" })).jobs, { done: 1 });
  catalog.close();
});
