import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "../../../packages/nks-pipeline/src/catalog.mjs";
import { GenerationQueue } from "../../../packages/nks-pipeline/src/generation-queue.mjs";
import { ToolService } from "../src/tool-service.mjs";

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
