import test from "node:test";
import assert from "node:assert/strict";
import { ConfirmationStore, hashPlan } from "../src/confirmation-store.mjs";

const plan = { method: "set_device_parameters", trackId: "t1", deviceId: "d1", changes: [{ id: "p1", value: 0.5 }] };

test("confirmation token is single-use and tied to the exact plan", () => {
  const store = new ConfirmationStore({ ttlMs: 60000 });
  const issued = store.issue(plan, 1000);
  assert.equal(store.consume(issued.token, hashPlan(plan), 2000).method, plan.method);
  assert.throws(() => store.consume(issued.token, hashPlan(plan), 2001), /unknown/);
});

test("confirmation token expires after sixty seconds", () => {
  const store = new ConfirmationStore({ ttlMs: 60000 });
  const issued = store.issue(plan, 1000);
  assert.throws(() => store.consume(issued.token, hashPlan(plan), 61001), /expired/);
});

test("confirmation token rejects a changed plan", () => {
  const store = new ConfirmationStore({ ttlMs: 60000 });
  const issued = store.issue(plan, 1000);
  const changed = { ...plan, changes: [{ id: "p1", value: 0.8 }] };
  assert.throws(() => store.consume(issued.token, hashPlan(changed), 2000), /plan hash/);
});
