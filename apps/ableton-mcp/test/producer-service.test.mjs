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
  assert.equal(packets[0].workflow, undefined);
  assert.equal(packets[0].creativeProposal, undefined);
  assert.ok(packets[1].creativeProposal);
  assert.ok(JSON.stringify(packets).length < 48000 * 2);
  assert.equal(artifacts.get("song", result.taskId).kind, "task");
  assert.ok(JSON.stringify(result).length < 5000);
});

test("an explicitly selected workflow reaches both specialists before their first observation round", async t => {
  const {service,packets,artifacts,calls}=await setup(t,()=>response());
  const result=await service.call('run_production_task',{projectId:'song',goal:'Propose only the next level adjustment',roles:'both',
    workflow:{name:'balance-mix',arguments:{request:'Set the named bass to -12 dB, keep the other tracks',mode:'autonomous'}}});
  assert.equal(result.status,'proposed');assert.equal(result.readsUsed,0);assert.equal(packets.length,2);
  for(const packet of packets){
    assert.equal(packet.workflow.workflow,'balance-mix');
    assert.ok(packet.workflow.messages[0].content.text.includes('Set the named bass to -12 dB, keep the other tracks'));
  }
  assert.match(result.workflowRef,/^[a-f0-9]{64}$/);
  const saved=artifacts.get('song',result.workflowRef);
  assert.equal(saved.kind,'workflow');assert.equal(saved.value.selection.name,'balance-mix');
  assert.equal(saved.value.selection.arguments.mode,'autonomous');
  assert.equal(artifacts.get('song',result.taskId).value.workflowRef,result.workflowRef);
  assert.equal(calls.some(call=>call.name==='set_track_mixer'),false);
});

test("invalid workflow choices fail before Live observation or a model request", async t => {
  for(const workflow of [{name:'missing'}, {name:'balance-mix'},
    {name:'balance-mix',arguments:{request:'Bass',mode:'guess'}},
    {name:'balance-mix',arguments:{request:'Bass',silenceOthers:'yes'}}]){
    const {service,calls,packets}=await setup(t,()=>response());
    await assert.rejects(service.call('run_production_task',{projectId:'song',goal:'Balance',workflow}));
    assert.equal(calls.length,0);assert.equal(packets.length,0);
  }
});

test("selected workflows retain valid empty optional arguments from public workflow retrieval", async t => {
  const {service,packets}=await setup(t,()=>response());
  const result=await service.call('run_production_task',{projectId:'song',goal:'Propose the next continuation phase',
    workflow:{name:'resume-session-work',arguments:{request:'Continue the named bass',previousContext:''}}});
  assert.equal(result.status,'proposed');assert.equal(packets[0].workflow.workflow,'resume-session-work');
});

test("workflow guidance never grants undiscovered operations or bypasses exact scope", async t => {
  for(const operation of [{tool:'load_simpler_sample',args:{trackId:'track-0',deviceId:'track-0:device-0',sourcePath:'/sample.wav'}},
    {tool:'set_track_mixer',args:{trackId:'track-1',pan:.25}}]){
    const {service,calls}=await setup(t,()=>response({operations:[operation]}));
    await assert.rejects(service.call('run_production_task',{projectId:'song',goal:'Refine this instrument',scope:{trackId:'track-0'},
      workflow:{name:'build-sample-instrument',arguments:{request:'Refine the named instrument'}}}),/allowed|scope/);
    assert.equal(calls.some(call=>call.name===operation.tool),false);
  }
});

test("a selected workflow remains subject to the existing model-input byte budget", async t => {
  const {service,packets}=await setup(t,()=>response());
  const result=await service.call('run_production_task',{projectId:'song',goal:'Plan the next phase',
    constraints:Array.from({length:12},()=> 'x'.repeat(2000)),
    workflow:{name:'build-sample-instrument',arguments:{request:'y'.repeat(6000)}}});
  assert.equal(result.status,'budget_exhausted');assert.equal(result.operationCount,0);assert.equal(packets.length,0);
  assert.equal(result.stopReason, 'input_limit');assert.deepEqual(result.turnRefs, []);
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

test("continued turns identify completed reads and discovered schemas before a guarded proposal", async t => {
  const { service, packets, artifacts } = await setup(t, packet => !packet.progress || packet.progress.turn === 1
    ? response({ reads: [
      { tool: "get_track_mixer", args: { trackId: "track-0" } },
      { tool: "discover_production_tools", args: { query: "set_track_volume_db", kind: "operation" } }
    ] }) : response({ operations: [{ tool: "set_track_volume_db", args: { trackId: "track-0", volumeDb: -12 } }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Lower the named track to -12 dB", scope: { trackId: "track-0" } });
  assert.equal(task.status, "proposed");
  assert.equal(task.operationCount, 1);
  assert.equal(task.readsUsed, 2);
  assert.deepEqual(packets[0].progress, { turn: 1, maxTurns: 3, readsRemaining: 8, completedReads: [] });
  const progress = packets[1].progress;
  assert.equal(progress.turn, 2); assert.equal(progress.readsRemaining, 6);
  assert.equal(progress.completedReads[0].tool, "get_track_mixer");
  const observation = artifacts.get("song", progress.completedReads[0].artifactId);
  assert.equal(observation.kind, "observation"); assert.equal(observation.value.args.trackId, "track-0");
  assert.deepEqual(progress.completedReads[1].discovery.names, ["set_track_volume_db"]);
  assert.ok(packets[1].tools.operations.some(tool => tool.name === "set_track_volume_db"));
  assert.equal(task.turnRefs.length, 2);
  assert.equal(progress.previousResultRef, task.turnRefs[0].resultRef);
  assert.deepEqual(progress.previousResponse, artifacts.get("song", progress.previousResultRef).value.result);
  for (const turn of task.turnRefs) {
    const saved = artifacts.get("song", turn.resultRef);
    assert.equal(saved.kind, "specialist-result"); assert.equal(saved.value.inputRef, turn.inputRef);
    assert.equal(artifacts.get("song", turn.inputRef).value.progress.turn, turn.turn);
  }
});

test("common gain proposals receive native dB schemas without an extra discovery turn", async t => {
  const { service, packets } = await setup(t, packet => packet.tools.operations.some(tool => tool.name === "set_track_volume_db") &&
    packet.tools.operations.some(tool => tool.name === "set_track_send_db")
    ? response({ operations: [{ tool: "set_track_volume_db", args: { trackId: "track-0", volumeDb: -12 } }] })
    : response({ reads: [{ tool: "discover_production_tools", args: { query: "set_track_volume_db", kind: "operation" } }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Lower the named track to -12 dB", scope: { trackId: "track-0" } });
  assert.equal(task.status, "proposed");assert.equal(task.operationCount, 1);
  assert.equal(packets.length, 1);assert.equal(task.readsUsed, 0);
  const schema = packets[0].tools.operations.find(tool => tool.name === "set_track_volume_db").inputSchema;
  assert.equal(schema.properties.volumeDb.type, "number");assert.equal(schema.properties.expectedStateVersion, undefined);
});

test("exhausted tasks retain intermediate replies and an explicit stopping reason without executable operations", async t => {
  const { service, packets, artifacts } = await setup(t, () => response({ reads: [{ tool: "get_live_state", args: {} }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Inspect this Set" });
  assert.equal(task.status, "budget_exhausted"); assert.equal(task.stopReason, "model_turn_limit");
  assert.equal(task.operationCount, 0); assert.equal(task.readsUsed, 2);
  assert.equal(task.turnRefs.length, 3);
  assert.equal(packets[2].progress.turn, 3); assert.equal(packets[2].progress.readsRemaining, 6);
  assert.equal(packets[2].progress.completedReads.length, 2);
  const saved = artifacts.get("song", task.taskId).value;
  assert.equal(saved.stopReason, "model_turn_limit"); assert.deepEqual(saved.turnRefs, task.turnRefs);
  assert.equal(artifacts.get("song", task.turnRefs[2].resultRef).value.result.reads.length, 1);
  await assert.rejects(service.call("apply_production_operation", { projectId: "song", taskId: task.taskId,
    operationIndex: 0, expectedStateVersion: 1 }), /incomplete/);
});

test("turn budgets remain shared across roles while each role starts its own continuation", async t => {
  const { service, packets } = await setup(t, packet => packet.role === "creative" && (!packet.progress || packet.progress.turn === 1)
    ? response({ reads: [{ tool: "get_live_state", args: {} }] }) : response());
  const task = await service.call("run_production_task", { projectId: "song", goal: "Plan this phase", roles: "both" });
  assert.equal(task.status, "proposed"); assert.equal(task.readsUsed, 1);
  assert.equal(packets.length, 3);
  assert.equal(packets[2].role, "functional");
  assert.deepEqual(packets[2].progress, { turn: 1, maxTurns: 3, readsRemaining: 7, completedReads: [] });
});

test("specialists can page their previous reply and receive the continuation offset", async t => {
  const { service, packets } = await setup(t, packet => !packet.progress || packet.progress.turn === 1
    ? response({ reads: [{ tool: "get_live_state", args: {} }] })
    : packet.progress.turn === 2
      ? response({ reads: [{ tool: "read_production_artifact", args: { artifactId: packet.progress.previousResultRef, offset: 0, limit: 100 } }] })
      : response());
  const task = await service.call("run_production_task", { projectId: "song", goal: "Review the previous reply" });
  assert.equal(task.status, "proposed");assert.equal(task.readsUsed, 2);
  const completed = packets[2].progress.completedReads[1];
  assert.equal(completed.tool, "read_production_artifact");assert.equal(completed.nextOffset, 100);
  assert.equal(completed.args.artifactId, task.turnRefs[0].resultRef);
});

test("a role cannot spend more reads than the remaining task budget", async t => {
  const reads = Array.from({ length: 4 }, () => ({ tool: "get_live_state", args: {} }));
  const { service, packets } = await setup(t, packet => packet.role === "creative" && packet.progress?.turn === 3
    ? response() : response({ reads }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Inspect", roles: "both" });
  assert.equal(task.status, "budget_exhausted");assert.equal(task.stopReason, "read_limit");
  assert.equal(task.readsUsed, 8);assert.equal(task.operationCount, 0);
  assert.equal(packets.at(-1).role, "functional");assert.equal(packets.at(-1).progress.readsRemaining, 0);
  assert.equal(task.turnRefs.length, 4);
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
