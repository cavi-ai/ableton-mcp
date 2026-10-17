import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProducerService } from "../src/producer-service.mjs";
import { ProducerArtifacts } from "../src/producer-artifacts.mjs";
import { ConfirmationStore } from "../src/confirmation-store.mjs";
import { withRequestSignal } from "../src/request-context.mjs";

const response = (extra = {}) => ({ summary: "Use a quieter bass.", reads: [], operations: [], checks: [], questions: [], alternatives: [], ...extra });
async function setup(t, generate) {
  const directory = await mkdtemp(join(tmpdir(), "producer-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let version = 1, tempo = 120;
  const calls = [], packets = [];
  const confirmations = new ConfirmationStore();
  const base = { async call(name, args = {}) {
    calls.push({ name, args });
    if (name === "get_live_state") return { stateVersion: version, setFingerprint: "set-a", tempo };
    if (name === "set_tempo") {
      assert.equal(args.expectedStateVersion, version);
      const plan = { tempo: args.tempo, stateVersion: version };
      if (args.dryRun !== false) return { dryRun: true, plan, confirmation: confirmations.issue(plan) };
      confirmations.consume(args.confirmationToken, args.planHash);
      tempo = args.tempo; version++;
      return { dryRun: false, tempo };
    }
    return { stateVersion: version, data: "x".repeat(12000) };
  }, readResource: async uri => ({ uri }) };
  const artifacts = new ProducerArtifacts(directory);
  const service = new ProducerService({ service: base, artifacts, config: { creative: {}, functional: {} },
    runtimeFactory: () => ({ generate: async packet => { packets.push(structuredClone(packet)); return generate(packet); } }) });
  return { service, base, artifacts, calls, packets, change: () => version++ };
}

test("context and role results are stored as bounded references; creative and functional inputs stay separate", async t => {
  const { service, artifacts, packets } = await setup(t, packet => response(packet.role === "functional" ?
    { operations: [{ tool: "set_tempo", args: { tempo: 100 } }] } : { alternatives: [{ name: "Sparse", description: "Fewer notes." }] }));
  const context = await service.call("get_production_context", { projectId: "song" });
  assert.ok(context.contextRef);
  assert.ok(JSON.stringify(context).length < 4000);
  const result = await service.call("run_production_task", { projectId: "song", goal: "Simplify the bass", roles: "both", contextRefs: [context.contextRef] });
  assert.equal(result.operationCount, 1);
  assert.equal(packets[0].role, "creative"); assert.equal(packets[1].role, "functional");
  assert.equal(packets[0].creativeProposal, undefined);
  assert.ok(packets[1].creativeProposal);
  assert.ok(JSON.stringify(packets).length < 48000 * 2);
  assert.equal(artifacts.get("song", result.taskId).kind, "task");
  assert.ok(JSON.stringify(result).length < 5000);
});

test("specialists can request bounded reads but cannot execute, escape scope or use arbitrary tools", async t => {
  for (const invalid of [response({ reads: [{ tool: "set_tempo", args: { tempo: 90 } }] }),
    response({ reads: [{ tool: "list_devices", args: { trackId: "track-1" } }] }),
    response({ operations: [{ tool: "open_live_set", args: {} }] }),
    response({ operations: [{ tool: "set_tempo", args: { tempo: 90, confirmationToken: "x" } }] })]) {
    const { service, calls } = await setup(t, () => invalid);
    await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "quieter bass", roles: "functional", scope: { trackId: "track-0" } }), /allowed|scope|confirmation|execution/);
    assert.equal(calls.some(call => call.name === "set_tempo"), false);
  }
});

test("read loops are bounded and return an incomplete task rather than an executable proposal", async t => {
  const { service } = await setup(t, () => response({ reads: [{ tool: "get_live_state", args: {} }] }));
  const result = await service.call("run_production_task", { projectId: "song", goal: "inspect", roles: "functional" });
  assert.equal(result.status, "budget_exhausted"); assert.equal(result.operationCount, 0);
  await assert.rejects(service.call("apply_production_operation", { projectId: "song", taskId: result.taskId, operationIndex: 0, expectedStateVersion: 1 }), /incomplete|operation/);
});

test("execution forwards existing confirmations, rejects stale tasks, and records readback without asserting musical quality", async t => {
  const { service, artifacts, change } = await setup(t, () => response({
    operations: [{ tool: "set_tempo", args: { tempo: 100 } }],
    checks: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 100 }]
  }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "tempo 100", roles: "functional" });
  const args = { projectId: "song", taskId: task.taskId, operationIndex: 0, expectedStateVersion: 1 };
  const plan = await service.call("apply_production_operation", args);
  assert.equal(plan.status, "planned");
  await assert.rejects(service.call("apply_production_operation", { ...args, dryRun: false, planHash: plan.planHash }), /confirmation/);
  const applied = await service.call("apply_production_operation", { ...args, dryRun: false,
    planHash: plan.planHash, confirmationToken: plan.confirmationToken });
  assert.equal(applied.status, "applied");
  assert.equal(applied.checks[0].matches, true);
  assert.equal(artifacts.get("song", applied.receiptId).value.after.tempo, 100);
  await assert.rejects(service.call("apply_production_operation", args), /stale/);
  change();
  await assert.rejects(service.call("apply_production_operation", { ...args, expectedStateVersion: 3 }), /stale/);
});

test("ordered proposals require the preceding receipt and reject intervening manual edits", async t => {
  const { service, change } = await setup(t, () => response({ operations: [
    { tool: "set_tempo", args: { tempo: 100 } }, { tool: "set_tempo", args: { tempo: 110 } }
  ] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "two changes", roles: "functional" });
  const first = { projectId: "song", taskId: task.taskId, operationIndex: 0, expectedStateVersion: 1 };
  const plan = await service.call("apply_production_operation", first);
  const receipt = await service.call("apply_production_operation", { ...first, dryRun: false, confirmationToken: plan.confirmationToken, planHash: plan.planHash });
  const second = { ...first, operationIndex: 1, expectedStateVersion: 2 };
  await assert.rejects(service.call("apply_production_operation", second), /receipt/);
  const next = await service.call("apply_production_operation", { ...second, previousReceiptId: receipt.receiptId });
  assert.equal(next.status, "planned");
  change();
  await assert.rejects(service.call("apply_production_operation", { ...second, previousReceiptId: receipt.receiptId, expectedStateVersion: 3 }), /stale/);
});

test("aborted work dispatches nothing, unconfigured specialists fail explicitly, and direct tools remain usable", async t => {
  const { service, calls, artifacts } = await setup(t, () => response());
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(withRequestSignal(controller.signal, () => service.call("run_production_task", { projectId: "song", goal: "inspect" })), /cancelled/);
  assert.equal(calls.length, 0);
  const unconfigured = new ProducerService({ service: { call: async () => ({ tempo: 120 }) }, artifacts, config: null });
  await assert.rejects(unconfigured.call("run_production_task", { projectId: "song", goal: "inspect", roles: "creative" }), /not configured/);
  assert.equal((await unconfigured.call("get_live_state", {})).tempo, 120);
});

test("unanswered questions prevent execution and the main response remains bounded", async t => {
  const { service } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }],
    questions: Array.from({ length: 8 }, () => "Which direction? ".repeat(100)) }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "choose direction", roles: "functional" });
  assert.equal(task.status, "needs_input");
  assert.equal(task.operationCount, 0);
  assert.ok(JSON.stringify(task).length < 4000);
});

test("failed declared postconditions cannot produce an applied receipt", async t => {
  const { service } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }],
    checks: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 110 }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "change tempo", roles: "functional" });
  const args = { projectId: "song", taskId: task.taskId, operationIndex: 0, expectedStateVersion: 1 };
  const plan = await service.call("apply_production_operation", args);
  const result = await service.call("apply_production_operation", { ...args, dryRun: false, confirmationToken: plan.confirmationToken, planHash: plan.planHash });
  assert.equal(result.status, "postconditions_failed"); assert.equal(result.checks[0].matches, false);
});

test("specialists discover additional tool schemas lazily without executing operations", async t => {
  const { service, packets, calls } = await setup(t, packet => packet.tools.operations.some(tool => tool.name === "create_scale_bassline_clip")
    ? response() : response({ reads: [{ tool: "discover_production_tools", args: { query: "create scale bassline", kind: "operation" } }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "plan a bassline", roles: "functional" });
  assert.equal(task.status, "proposed");
  assert.equal(packets.length, 2);
  const schema = packets[1].tools.operations.find(tool => tool.name === "create_scale_bassline_clip").inputSchema;
  assert.equal(schema.properties.expectedStateVersion, undefined);
  assert.ok(schema.properties.degrees);
  assert.equal(calls.some(call => call.name === "create_scale_bassline_clip"), false);
});

test("native not-executed outcomes are preserved in rejected receipts", async t => {
  const { service, base, artifacts } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "tempo", roles: "functional" });
  const original = base.call;
  base.call = (name, args) => name === "set_tempo" ? Promise.reject(Object.assign(new Error("native state changed"), { outcome: "not_executed" })) : original(name, args);
  const rejected = await service.call("apply_production_operation", { projectId: "song", taskId: task.taskId,
    operationIndex: 0, expectedStateVersion: 1, dryRun: false, confirmationToken: "token", planHash: "hash" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.outcome, "not_executed");
  assert.equal(artifacts.get("song", rejected.receiptId).value.outcome, "not_executed");
});

test("an operation awaiting user action is not reported as applied", async t => {
  const { service, base } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "tempo", roles: "functional" });
  const original = base.call;
  base.call = (name, args) => name === "set_tempo" ? Promise.resolve({ dryRun: false, pendingUserAction: true }) : original(name, args);
  const result = await service.call("apply_production_operation", { projectId: "song", taskId: task.taskId,
    operationIndex: 0, expectedStateVersion: 1, dryRun: false, confirmationToken: "token", planHash: "hash" });
  assert.equal(result.status, "pending_user_action");
});
