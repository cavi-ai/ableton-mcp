import test from "node:test";
import assert from "node:assert/strict";
import { GenerationQueue } from "../src/generation-queue.mjs";

const records = [
  { id: "serum-2:b", productSlug: "serum-2", state: "discovered", attempts: 0 },
  { id: "serum-2:a", productSlug: "serum-2", state: "discovered", attempts: 0 }
];

test("queue leases deterministic next work and heartbeats it", () => {
  const queue = new GenerationQueue(records, { leaseMs: 60000, maxAttempts: 3 });
  const leased = queue.lease("worker-1", 1000);
  assert.equal(leased.id, "serum-2:a");
  assert.equal(leased.state, "loading");
  assert.equal(queue.heartbeat(leased.id, "worker-1", 2000).leaseExpiresAt, 62000);
});

test("queue recovers stale leases but not active leases", () => {
  const queue = new GenerationQueue(records, { leaseMs: 60000, maxAttempts: 3 });
  queue.lease("worker-1", 1000);
  assert.equal(queue.lease("worker-2", 2000).id, "serum-2:b");
  assert.equal(queue.recoverStale(61001), 1);
  assert.equal(queue.lease("worker-3", 61002).id, "serum-2:a");
});

test("queue advances success and quarantines after max attempts", () => {
  const queue = new GenerationQueue(records, { leaseMs: 60000, maxAttempts: 2 });
  let leased = queue.lease("worker-1", 1000);
  queue.complete(leased.id, "worker-1", "nks_saved", { fileName: "a.nksf" }, 2000);
  assert.equal(queue.get(leased.id).state, "nks_saved");
  leased = queue.lease("worker-1", 3000);
  queue.fail(leased.id, "worker-1", "load_failed", 4000);
  leased = queue.lease("worker-1", 5000);
  queue.fail(leased.id, "worker-1", "load_failed", 6000);
  assert.equal(queue.get(leased.id).state, "quarantined");
});
