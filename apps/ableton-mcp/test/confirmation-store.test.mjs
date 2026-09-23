import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as confirmations from "../src/confirmation-store.mjs";

const { ConfirmationStore, hashPlan } = confirmations;

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

test("file confirmation survives a new process boundary and is consumed once", async () => {
  assert.equal(typeof confirmations.FileConfirmationStore, "function");
  const root = await mkdtemp(join(tmpdir(), "ableton-confirmations-"));
  const issuer = new confirmations.FileConfirmationStore({ directory: root, ttlMs: 60000 });
  const issued = issuer.issue(plan, 1000);

  assert.equal((await stat(root)).mode & 0o777, 0o700);
  const [entry] = await readdir(root);
  assert.equal((await stat(join(root, entry))).mode & 0o777, 0o600);

  const consumer = new confirmations.FileConfirmationStore({ directory: root, ttlMs: 60000 });
  assert.equal(consumer.consume(issued.token, hashPlan(plan), 2000).method, plan.method);
  assert.throws(() => issuer.consume(issued.token, hashPlan(plan), 2001), /unknown/);
});

test("file confirmation rejects expired and altered plans across instances", async () => {
  assert.equal(typeof confirmations.FileConfirmationStore, "function");
  const root = await mkdtemp(join(tmpdir(), "ableton-confirmations-"));
  const issuer = new confirmations.FileConfirmationStore({ directory: root, ttlMs: 60000 });
  const changed = { ...plan, changes: [{ id: "p1", value: 0.8 }] };

  const altered = issuer.issue(plan, 1000);
  assert.throws(
    () => new confirmations.FileConfirmationStore({ directory: root }).consume(altered.token, hashPlan(changed), 2000),
    /plan hash/
  );

  const expired = issuer.issue(plan, 1000);
  assert.throws(
    () => new confirmations.FileConfirmationStore({ directory: root }).consume(expired.token, hashPlan(plan), 61001),
    /expired/
  );
});

test("file confirmation issuance removes abandoned expired entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ableton-confirmations-"));
  const store = new confirmations.FileConfirmationStore({ directory: root, ttlMs: 60000 });
  store.issue(plan, 1000);
  store.issue(plan, 61001);
  assert.equal((await readdir(root)).length, 1);
});
