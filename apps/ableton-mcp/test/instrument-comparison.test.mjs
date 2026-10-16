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
  const adoption = { stateVersion: 4, setFingerprint: "set", original: { trackId: "track-0", clipId: "track-0:clip-0", notes: [1] },
    variation: { trackId: "track-1", clipId: "track-1:clip-0", notes: [2] }, restoreMutes: { original: true, variation: false } };
  const service = new ToolService({ bridge: { request: async (method, args) => {
    if (method === "get_instrument_comparison_adoption_source") return structuredClone(adoption);
    if (method === "get_instrument_comparison_source") return structuredClone(source);
    if (method === "get_instrument_comparison") return structuredClone(pair);
    if (["prepare_instrument_comparison", "select_instrument_comparison", "adopt_instrument_comparison"].includes(method)) {
      writes.push({ method, args }); return { ...pair, stateVersion: 5 };
    }
    throw new Error(`unexpected ${method}`);
  } } });
  return { service, source, pair, adoption, writes };
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

test("adoption binds both existing parts and consumes a single-use confirmation", async () => {
  const { service, adoption, writes } = fixture();
  const args = { original: { trackId: "track-0", clipId: "track-0:clip-0" }, variation: { trackId: "track-1", clipId: "track-1:clip-0" }, expectedStateVersion: 4 };
  const plan = await service.call("adopt_instrument_comparison", args);
  assert.equal(plan.dryRun, true);assert.deepEqual(plan.plan.restoreMutes, adoption.restoreMutes);assert.equal(writes.length, 0);
  const confirmed = { ...args, dryRun: false, confirmationToken: plan.confirmation.token, planHash: plan.confirmation.planHash };
  await service.call("adopt_instrument_comparison", confirmed);
  assert.equal(writes.length, 1);assert.deepEqual(writes[0].args.before, adoption);
  await assert.rejects(service.call("adopt_instrument_comparison", confirmed), /confirmation token/);
  const second = await service.call("adopt_instrument_comparison", args);
  adoption.variation.notes = [3];
  await assert.rejects(service.call("adopt_instrument_comparison", { ...args, dryRun: false,
    confirmationToken: second.confirmation.token, planHash: second.confirmation.planHash }), /hash mismatch|changed/);
  assert.equal(writes.length, 1);
});

test("adoption discovery is guarded, all-profile and requires two exact part references", async () => {
  const { service, writes } = fixture(), route = createRouter(service);
  const tool = (await route({id:1,method:"tools/list"})).result.tools.find(t => t.name === "adopt_instrument_comparison");
  assert.equal(tool?.annotations.readOnlyHint, false);
  const core = createRouter(service,{toolProfile:"core"});
  assert.equal((await core({id:2,method:"tools/list"})).result.tools.some(t => t.name === "adopt_instrument_comparison"), false);
  for (const args of [{}, {original:{trackId:"track-0",clipId:"track-0:clip-0"},variation:{trackId:"track-1"},expectedStateVersion:4}]) {
    const result = await route({id:3,method:"tools/call",params:{name:"adopt_instrument_comparison",arguments:args}});
    assert.ok(result.error || result.result?.isError);
  }
  assert.equal(writes.length, 0);
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
