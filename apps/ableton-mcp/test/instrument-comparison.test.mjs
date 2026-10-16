import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";

function fixture() {
  const source = { stateVersion: 4, setFingerprint: "set", trackId: "track-0", clipId: "track-0:clip-0",
    source: { name: "Original", notesDigest: "one" }, tracks: [{ id: "track-0", name: "Original" }] };
  const pair = { stateVersion: 4, comparisonId: "comparison", original: { trackId: "track-0", mute: false },
    variation: { trackId: "track-1", mute: true }, readinessErrors: [] };
  const writes = [];
  const service = new ToolService({ bridge: { request: async (method, args) => {
    if (method === "get_instrument_comparison_source") return structuredClone(source);
    if (method === "get_instrument_comparison") return structuredClone(pair);
    if (["prepare_instrument_comparison", "select_instrument_comparison"].includes(method)) {
      writes.push({ method, args }); return { ...pair, stateVersion: 5 };
    }
    throw new Error(`unexpected ${method}`);
  } } });
  return { service, source, pair, writes };
}
const prepare = { trackId: "track-0", clipId: "track-0:clip-0", name: "Warm", expectedStateVersion: 4 };

test("preparing a comparison is read-only until a single-use confirmation is consumed", async () => {
  const { service, writes } = fixture();
  const plan = await service.call("prepare_instrument_comparison", prepare);
  assert.equal(plan.dryRun, true);
  assert.equal(writes.length, 0);
  const confirmed = { ...prepare, dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash };
  assert.equal((await service.call("prepare_instrument_comparison", confirmed)).observed.stateVersion, 5);
  assert.equal(writes.length, 1);
  await assert.rejects(service.call("prepare_instrument_comparison", confirmed), /confirmation token/);
});

test("source edits and target-name changes invalidate confirmation without relying on native stateVersion", async () => {
  for (const change of ["content", "name"]) {
    const { service, source, writes } = fixture();
    const plan = await service.call("prepare_instrument_comparison", prepare);
    if (change === "content") source.source.notesDigest = "manual-edit";
    await assert.rejects(service.call("prepare_instrument_comparison", { ...prepare,
      ...(change === "name" ? { name: "Different" } : {}), dryRun: false,
      confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }), /hash mismatch|changed/);
    assert.equal(writes.length, 0);
  }
});

test("select plans bind the exact pair's current state, choice and native version", async () => {
  const { service, pair, writes } = fixture();
  const args = { comparisonId: "comparison", choice: "variation", expectedStateVersion: 4 };
  const plan = await service.call("select_instrument_comparison", args);
  pair.variation.mute = false;
  await assert.rejects(service.call("select_instrument_comparison", { ...args, dryRun: false,
    confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash }), /hash mismatch|changed/);
  assert.equal(writes.length, 0);
  await assert.rejects(service.call("select_instrument_comparison", { ...args, expectedStateVersion: 3 }), /changed|stale|version/i);
});

test("invalid names and choices cannot issue a native write", async () => {
  for (const name of ["", " ", "x".repeat(129)]) {
    const { service, writes } = fixture();
    await assert.rejects(service.call("prepare_instrument_comparison", { ...prepare, name }));
    assert.equal(writes.length, 0);
  }
  const { service } = fixture();
  await assert.rejects(service.call("select_instrument_comparison", { comparisonId: "comparison",
    choice: "all", expectedStateVersion: 4 }));
});

test("the comparison read is read-only and tools have accurate discovery annotations", async () => {
  const { service, writes } = fixture();
  const route = createRouter(service);
  const tools = (await route({ id: 1, method: "tools/list" })).result.tools;
  for (const name of ["prepare_instrument_comparison", "select_instrument_comparison"])
    assert.equal(tools.find(t => t.name === name)?.annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === "get_instrument_comparison")?.annotations.readOnlyHint, true);
  const read = await route({ id: 2, method: "tools/call", params: {
    name: "get_instrument_comparison", arguments: { comparisonId: "comparison" } } });
  assert.equal(read.result.structuredContent.original.trackId, "track-0");
  assert.equal(writes.length, 0);
});
