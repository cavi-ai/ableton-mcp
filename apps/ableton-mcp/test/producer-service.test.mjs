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
    if (name === "get_live_state") return { stateVersion: version, setFingerprint: "set-a", filePath: "/music/song.als", tempo };
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
  return { service, base, artifacts, calls, packets, change: () => version++,
    reopen: () => new ProducerService({ service: base, artifacts: new ProducerArtifacts(directory), config: { creative: {}, functional: {} },
      runtimeFactory: service.runtimeFactory }) };
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
  assert.equal(packets[0].postconditions, undefined);
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

test('entry workflow permits a scoped specialist proposal without executing it',async t=>{
  const {service,packets,calls}=await setup(t,()=>response({operations:[{tool:'set_session_clip_entry',args:{trackId:'track-0',clipId:'track-0:clip-0',unit:'beats',start:2}}]}));
  const result=await service.call('run_production_task',{projectId:'song',goal:'Compare the entry on a copy',roles:'functional',workflow:{name:'compare-clip-entry',arguments:{request:'Try the copied phrase from beat 2',mode:'autonomous'}}});
  assert.equal(result.operationCount,1);
  assert.equal(packets[0].workflow.workflow,'compare-clip-entry');
  assert.equal(calls.some(c=>c.name==='set_session_clip_entry'),false);
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
  assert.equal(task.checkSource, "specialist");assert.equal(result.checkSource, "specialist");
  assert.equal(result.postconditionsRef, undefined);
});

for (const { expected, status, matches } of [
  { expected: 100, status: "applied", matches: true },
  { expected: 101, status: "postconditions_failed", matches: false }
]) test(`caller postconditions determine ${status} while specialist suggestions stay visible`, async t => {
  const postconditions = [{ tool: "get_live_state", args: {}, path: ["tempo"], expected }];
  const { service, artifacts, packets } = await setup(t, packet => {
    packet.postconditions?.splice(0, 1);
    return response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }],
      checks: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 999 }] });
  });
  const task = await service.call("run_production_task", { projectId: "song", goal: "Set tempo to 100", postconditions });
  postconditions[0].expected = 777;
  assert.equal(task.checkSource, "caller");assert.equal(task.suggestedCheckCount, 1);
  assert.equal(packets[0].postconditions[0].expected, expected);
  const saved = artifacts.get("song", task.postconditionsRef);
  assert.equal(saved.kind, "postconditions");assert.equal(saved.value[0].expected, expected);
  const proposal = artifacts.get("song", task.taskId).value;
  assert.equal(proposal.checks[0].expected, expected);
  assert.equal(proposal.results[0].result.checks[0].expected, 999);
  const args = { projectId: "song", taskId: task.taskId, operationIndex: 0, expectedStateVersion: 1 };
  const plan = await service.call("apply_production_operation", args);
  assert.equal(plan.postconditionsRef, task.postconditionsRef);assert.equal(plan.checkSource, "caller");
  const receipt = await service.call("apply_production_operation", { ...args, dryRun: false,
    confirmationToken: plan.confirmationToken, planHash: plan.planHash });
  assert.equal(receipt.status, status);assert.equal(receipt.checkSource, "caller");
  assert.equal(receipt.postconditionsRef, task.postconditionsRef);assert.equal(receipt.checks.length, 1);
  assert.equal(receipt.checks[0].matches, matches);assert.equal(receipt.audibleQualityVerified, false);
  assert.equal(artifacts.get("song", receipt.receiptId).value.checkSource, "caller");
});

test("invalid caller postconditions fail before Live or model calls", async t => {
  for (const postconditions of [[],
    [{ tool: "missing", args: {}, path: [], expected: null }],
    [{ tool: "set_tempo", args: { tempo: 100 }, path: [], expected: null }],
    [{ tool: "get_live_state", args: { unexpected: true }, path: [], expected: null }],
    [{ tool: "get_track_mixer", args: { trackId: "track-1" }, path: ["mute"], expected: false }],
    [{ tool: "get_production_context", args: { projectId: "song" }, path: [], expected: null }]
  ]) {
    const { service, calls, packets } = await setup(t, () => response());
    await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "Inspect this track",
      scope: { trackId: "track-0" }, postconditions }));
    assert.equal(calls.length, 0);assert.equal(packets.length, 0);
  }
});

test("caller postcondition read schemas reach both roles without discovery and do not authorize writes", async t => {
  const { service, packets, artifacts } = await setup(t, () => response());
  const task = await service.call("run_production_task", { projectId: "song", goal: "Plan the next edit", roles: "both",
    scope: { trackId: "track-0" }, postconditions: [{ tool: "get_track_freeze_state", args: { trackId: "track-0" }, path: ["frozen"], expected: false }] });
  assert.equal(task.status, "proposed");assert.equal(task.operationCount, 0);assert.equal(task.readsUsed, 0);
  for (const packet of packets) {
    assert.equal(packet.postconditions[0].tool, "get_track_freeze_state");
    assert.ok(packet.tools.reads.some(tool => tool.name === "get_track_freeze_state"));
    assert.equal(packet.tools.operations.some(tool => tool.name === "get_track_freeze_state"), false);
  }
  assert.equal(artifacts.get("song", task.taskId).value.allowedReads.includes("get_track_freeze_state"), true);
});

test("caller criteria preserve unanswered-question and input-budget barriers", async t => {
  const { service } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }], questions: ["Which passage?"] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Set tempo",
    postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 100 }] });
  assert.equal(task.status, "needs_input");assert.equal(task.operationCount, 0);
  const budget = await setup(t, () => response());
  const large = await budget.service.call("run_production_task", { projectId: "song", goal: "Inspect",
    postconditions: [{ tool: "get_live_state", args: {}, path: [], expected: "x".repeat(48000) }] });
  assert.equal(large.status, "budget_exhausted");assert.equal(large.stopReason, "input_limit");
  assert.equal(large.operationCount, 0);assert.equal(budget.packets.length, 0);
});

test("caller criteria cannot authorize an out-of-scope specialist check", async t => {
  const { service, calls } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }],
    checks: [{ tool: "get_track_mixer", args: { trackId: "track-1" }, path: ["mute"], expected: false }] }));
  await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "Plan", scope: { trackId: "track-0" },
    postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 100 }] }), /scope/);
  assert.equal(calls.some(call => call.name === "set_tempo"), false);
});

test("execution refuses caller checks that differ from their saved criteria reference", async t => {
  const { service, artifacts, calls } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Set tempo to 100",
    postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 100 }] });
  const changed = artifacts.get("song", task.taskId).value;
  changed.checks[0].expected = 999;
  const taskId = artifacts.put("song", "task", changed);
  await assert.rejects(service.call("apply_production_operation", { projectId: "song", taskId, operationIndex: 0, expectedStateVersion: 1 }), /saved reference/);
  assert.equal(calls.some(call => call.name === "set_tempo"), false);
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

test("producer specialists discover and read exact device activation context", async t => {
  let round = 0;
  const {service,packets,calls}=await setup(t,()=>++round===1
    ? response({reads:[{tool:'discover_production_tools',args:{query:'get_device_activation_context',kind:'read'}}]})
    : round===2 ? response({reads:[{tool:'get_device_activation_context',args:{trackId:'track-0',deviceId:'track-0:device-0'}}]}) : response());
  const result=await service.call('run_production_task',{projectId:'song',goal:'Inspect this effect before comparing bypass',roles:'functional',
    workflow:{name:'compare-effect-bypass',arguments:{request:'Compare the named EQ and preserve playback'}}});
  assert.equal(result.status,'proposed');
  assert.equal(packets.length,3);
  assert.equal(calls.filter(c=>c.name==='get_device_activation_context').length,1);
  assert.equal(calls.some(c=>c.name==='set_device_active'),false);
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


test("production sessions select a creative alternative before functional execution and retain feedback", async t => {
  const { service, artifacts, packets } = await setup(t, packet => response(packet.role === "creative" ?
    { alternatives: [{ name: "Sparse", description: "Preserve the original; create a quieter alternative." }] } :
    { operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Try a quieter bass", constraints: ["Preserve originals"] });
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, ...args });
  assert.equal(session.phase, "inspect");
  session = await advance({ action: "propose" });
  assert.equal(session.phase, "choose");
  assert.equal(packets.length, 1); assert.equal(packets[0].role, "creative");
  await assert.rejects(advance({ action: "apply", expectedStateVersion: 1 }), /phase/);
  session = await advance({ action: "choose", alternativeIndex: 0 });
  session = await advance({ action: "propose" });
  assert.equal(session.phase, "apply");
  assert.equal(packets[1].role, "functional");
  assert.ok(packets[1].context.some(item => item.kind === "selection" && item.text.includes("Sparse")));
  const plan = await advance({ action: "apply", expectedStateVersion: 1 });
  assert.equal(plan.operation.status, "planned");
  session = await advance({ action: "apply", expectedStateVersion: 1, dryRun: false,
    confirmationToken: plan.operation.confirmationToken, planHash: plan.operation.planHash });
  assert.equal(session.phase, "audition");
  await assert.rejects(advance({ action: "evaluate", decision: "accept" }), /feedback|phase/);
  session = await advance({ action: "feedback", text: "The bass is less busy; I prefer this version." });
  session = await advance({ action: "evaluate", decision: "accept" });
  assert.equal(session.phase, "complete");
  assert.equal(session.audibleQualityVerified, false);
  const saved = artifacts.get("song", session.sessionRef).value;
  assert.equal(artifacts.get("song", saved.feedbackRef).kind, "feedback");
  assert.equal(artifacts.get("song", saved.receiptId).value.status, "applied");
  assert.ok(JSON.stringify(session).length < 6000);
});

test("resuming after a manual edit invalidates saved proposals without changing Live", async t => {
  const { service, calls, change } = await setup(t, packet => response(packet.role === "creative" ?
    { alternatives: [{ name: "Sparse", description: "Less busy" }] } : { operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Refine bass", scope: { trackId: "track-0" } });
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, ...args });
  session = await advance({ action: "propose" });
  session = await advance({ action: "choose", alternativeIndex: 0 });
  session = await advance({ action: "propose" });
  change();
  session = await advance({ action: "resume" });
  assert.equal(session.phase, "inspect");
  assert.equal(session.taskId, undefined);
  assert.equal(session.stateChanged, true);
  assert.equal(calls.filter(call => call.name === "set_tempo").length, 0);
  await assert.rejects(advance({ action: "apply", expectedStateVersion: 2 }), /phase/);
});

test("a restarted service inspects an interrupted execution instead of replaying it", async t => {
  const { service, artifacts, calls, reopen } = await setup(t, () => response());
  const started = await service.call("start_production_session", { projectId: "song", goal: "Preserve bass" });
  const saved = artifacts.session("song", started.sessionId);
  artifacts.advanceSession("song", started.sessionId, started.revision, { ...saved.value, phase: "execution_pending", status: "outcome_unknown" });
  const next = reopen();
  const restored = await next.call("get_production_session", { projectId: "song", sessionId: started.sessionId });
  assert.equal(restored.phase, "execution_pending");
  await assert.rejects(next.call("advance_production_session", { projectId: "song", sessionId: started.sessionId,
    expectedRevision: restored.revision, action: "apply", expectedStateVersion: 1 }), /phase/);
  const resumed = await next.call("advance_production_session", { projectId: "song", sessionId: started.sessionId,
    expectedRevision: restored.revision, action: "resume" });
  assert.equal(resumed.phase, "inspect");
  assert.equal(resumed.status, "interrupted_inspect_before_proposing");
  assert.equal(calls.filter(call => call.name === "set_tempo").length, 0);
});

test("a production session refuses another Set and stale concurrent choices", async t => {
  const { service, base, reopen } = await setup(t, () => response({ alternatives: [{ name: "Sparse", description: "Less busy" }] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Bass" });
  const args = action => ({ projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, action });
  session = await service.call("advance_production_session", args("propose"));
  const choice = { ...args("choose"), alternativeIndex: 0 };
  await service.call("advance_production_session", choice);
  await assert.rejects(reopen().call("advance_production_session", choice), /revision/);
  const current = await service.call("get_production_session", { projectId: "song", sessionId: session.sessionId });
  const original = base.call.bind(base);
  base.call = async (name, args) => name === "get_live_state" ? { stateVersion: 1, setFingerprint: "set-b", filePath: "/music/another.als" } : original(name, args);
  await assert.rejects(service.call("advance_production_session", { ...args("resume"), expectedRevision: current.revision }), /Set identity/);
});

test("failed execution outcomes require resume before any new proposal", async t => {
  const { service, base, artifacts } = await setup(t, packet => response(packet.role === "creative" ?
    { alternatives: [{ name: "Sparse", description: "Less busy" }] } : { operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Bass" });
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, ...args });
  session = await advance({ action: "propose" });
  session = await advance({ action: "choose", alternativeIndex: 0 });
  session = await advance({ action: "propose" });
  const plan = await advance({ action: "apply", expectedStateVersion: 1 });
  const original = base.call.bind(base);
  base.call = async (name, args) => {
    if (name === "set_tempo" && args.dryRun === false) throw new Error("connection lost");
    return original(name, args);
  };
  session = await advance({ action: "apply", expectedStateVersion: 1, dryRun: false,
    confirmationToken: plan.operation.confirmationToken, planHash: plan.operation.planHash });
  assert.equal(session.phase, "needs_inspection");
  assert.equal(artifacts.get("song", session.receiptId).value.status, "outcome_unknown");
  await assert.rejects(advance({ action: "propose" }), /phase/);
});

test("resume accepts edits to a saved Set while invalidating its prior proposal", async t => {
  const { service, base } = await setup(t, () => response({ alternatives: [{ name: "Sparse", description: "Less busy" }] }));
  const started = await service.call("start_production_session", { projectId: "song", goal: "Bass" });
  const original = base.call.bind(base);
  base.call = async (name, args) => name === "get_live_state" ? { stateVersion: 1, setFingerprint: "renamed-track", filePath: "/music/song.als" } : original(name, args);
  const resumed = await service.call("advance_production_session", { projectId: "song", sessionId: started.sessionId, expectedRevision: started.revision, action: "resume" });
  assert.equal(resumed.phase, "inspect");
  assert.equal(resumed.stateChanged, true);
});

test("resume detects MIDI edits even when the bridge version and Set fingerprint are unchanged", async t => {
  const { service, base } = await setup(t, () => response({ alternatives: [{ name: "Sparse", description: "Less busy" }] }));
  let pitch = 60;
  const original = base.call.bind(base);
  base.call = async (name, args) => name === "list_clips" ? { clips: [{ id: "track-0:clip-0", isMidi: true }] }
    : name === "get_midi_clip_notes_extended" ? { notes: [{ pitch, start: 0, duration: 1 }] } : original(name, args);
  let session = await service.call("start_production_session", { projectId: "song", goal: "Bass", scope: { trackId: "track-0", clipId: "track-0:clip-0" } });
  const advance = action => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, action });
  session = await advance("propose");
  pitch = 62;
  session = await advance("resume");
  assert.equal(session.stateChanged, true);
  assert.equal(session.phase, "inspect");
  assert.equal(session.taskId, undefined);
});

test("empty functional proposals cannot bypass caller postconditions at acceptance", async t => {
  const { service, artifacts } = await setup(t, () => response({ alternatives: [{ name: "Sparse", description: "Less busy" }] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Tempo 100",
    postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 100 }] });
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, ...args });
  session = await advance({ action: "propose" });
  session = await advance({ action: "choose", alternativeIndex: 0 });
  session = await advance({ action: "propose" });
  session = await advance({ action: "feedback", text: "I prefer this version." });
  session = await advance({ action: "evaluate", decision: "accept" });
  assert.equal(session.phase, "evaluate");
  assert.equal(session.status, "postconditions_failed");
  assert.equal(session.checks[0].matches, false);
  assert.equal(artifacts.get("song", session.evaluationRef).value.checks[0].matches, false);
});

test("listening feedback informs both specialists when the user requests another revision", async t => {
  const { service, packets } = await setup(t, () => response({ alternatives: [{ name: "Sparse", description: "Less busy" }] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Refine bass" });
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, ...args });
  for (const args of [{ action: "propose" }, { action: "choose", alternativeIndex: 0 }, { action: "propose" },
    { action: "feedback", text: "Keep the syncopation but reduce the density." }, { action: "evaluate", decision: "revise" },
    { action: "propose" }, { action: "choose", alternativeIndex: 0 }, { action: "propose" }]) session = await advance(args);
  for (const packet of packets.slice(-2)) assert.ok(packet.context.some(item => item.kind === "feedback" && item.text.includes("Keep the syncopation")));
});

async function appliedSession(t) {
  const fixture = await setup(t, packet => response(packet.role === "creative" ?
    { alternatives: [{ name: "Sparse", description: "Less busy" }] } : { operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  let playing = false;
  const original = fixture.base.call.bind(fixture.base);
  fixture.base.call = async (name, args) => {
    const result = await original(name, args);
    return name === "get_live_state" ? { ...result, isPlaying: playing } : result;
  };
  let session = await fixture.service.call("start_production_session", { projectId: "song", goal: "Refine bass", scope: { trackId: "track-0" },
    postconditions: [{ tool: "get_live_state", args: {}, path: ["isPlaying"], expected: false }] });
  const advance = args => fixture.service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, ...args });
  for (const args of [{ action: "propose" }, { action: "choose", alternativeIndex: 0 }, { action: "propose" }]) session = await advance(args);
  const plan = await advance({ action: "apply", expectedStateVersion: 1 });
  session = await advance({ action: "apply", expectedStateVersion: 1, dryRun: false,
    confirmationToken: plan.operation.confirmationToken, planHash: plan.operation.planHash });
  assert.equal(session.phase, "audition");
  return { ...fixture, session, setPlaying: value => { playing = value; fixture.change(); } };
}

for (const phase of ["audition", "evaluate", "complete"]) test(`resume retains ${phase} evidence after a version advance with unchanged scoped content`, async t => {
  const { service, artifacts, reopen, change, packets, calls, session: started } = await appliedSession(t);
  let session = started;
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, ...args });
  if (phase !== "audition") session = await advance({ action: "feedback", text: "Test listening preference." });
  if (phase === "complete") session = await advance({ action: "evaluate", decision: "accept" });
  const before = session;
  change();
  session = await reopen().call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, action: "resume" });
  assert.equal(session.phase, phase === "complete" ? "evaluate" : phase);
  assert.equal(session.stateChanged, true);
  for (const key of ["taskId", "receiptId", "selectedRef", "feedbackRef"]) assert.equal(session[key], before[key]);
  if (phase === "complete") {
    assert.equal(session.status, "requires_evaluation");
    assert.equal(session.evaluationRef, undefined);
    assert.equal(session.userDecision, undefined);
    assert.equal(artifacts.get("song", before.evaluationRef).value.decision, "accept");
  } else assert.equal(session.evaluationRef, before.evaluationRef);
  assert.equal(session.basis.stateVersion, 3);
  assert.equal(artifacts.get("song", session.taskId).value.basis.stateVersion, 1);
  assert.equal(artifacts.get("song", session.receiptId).value.after.stateVersion, 2);
  await assert.rejects(advance({ action: "apply", expectedStateVersion: 3 }), /phase/);
  assert.equal(packets.length, 2);
  assert.equal(calls.filter(call => call.name === "set_tempo" && call.args.dryRun === false).length, 1);
});

test("feedback and evaluation tolerate version advances but still enforce declared playback checks", async t => {
  const { service, setPlaying, session: started } = await appliedSession(t);
  let session = started;
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, ...args });
  setPlaying(true);
  session = await advance({ action: "feedback", text: "Test preference after playback." });
  assert.equal(session.phase, "evaluate");
  assert.equal(session.basis.stateVersion, 3);
  session = await advance({ action: "evaluate", decision: "accept" });
  assert.equal(session.phase, "evaluate");
  assert.equal(session.status, "postconditions_failed");
  assert.equal(session.checks[0].matches, false);
  setPlaying(false);
  session = await advance({ action: "evaluate", decision: "accept" });
  assert.equal(session.phase, "complete");
  assert.equal(session.basis.stateVersion, 4);
  assert.equal(session.audibleQualityVerified, false);
});

for (const edit of ["scoped mixer", "fingerprint", "version regression"]) test(`resume invalidates audition evidence after ${edit} changes`, async t => {
  const { service, base, session } = await appliedSession(t);
  const original = base.call.bind(base);
  base.call = async (name, args) => {
    const value = await original(name, args);
    if (edit === "scoped mixer" && name === "get_track_mixer") return { ...value, volume: { value: 0.7 } };
    if (edit === "fingerprint" && name === "get_live_state") return { ...value, setFingerprint: "edited-set" };
    if (edit === "version regression" && name === "get_live_state") return { ...value, stateVersion: 1 };
    return value;
  };
  await assert.rejects(service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, action: "feedback", text: "Test preference." }), /state changed/);
  const resumed = await service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, action: "resume" });
  assert.equal(resumed.phase, "inspect");
  assert.equal(resumed.taskId, undefined);
  assert.equal(resumed.receiptId, undefined);
});

test("acceptance rejects a version change during required outcome checks", async t => {
  const { service, base, change } = await setup(t, () => response({ alternatives: [{ name: "Sparse", description: "Less busy" }] }));
  let canUndo = true, changeDuringCheck = false;
  const original = base.call.bind(base);
  base.call = async (name, args) => {
    if (name !== "get_history_state") return original(name, args);
    const result = { canUndo };
    if (changeDuringCheck) { canUndo = false; change(); }
    return result;
  };
  let session = await service.call("start_production_session", { projectId: "song", goal: "Compare bass",
    postconditions: [{ tool: "get_history_state", args: {}, path: ["canUndo"], expected: true }] });
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, ...args });
  for (const args of [{ action: "propose" }, { action: "choose", alternativeIndex: 0 }, { action: "propose" },
    { action: "feedback", text: "Test listening preference." }]) session = await advance(args);
  changeDuringCheck = true;
  await assert.rejects(advance({ action: "evaluate", decision: "accept" }), /state changed/);
  assert.equal((await service.call("get_production_session", { projectId: "song", sessionId: session.sessionId })).phase, "evaluate");
});

test("resuming accepted work requires fresh checks against the current playback state", async t => {
  const { service, setPlaying, session: started } = await appliedSession(t);
  let session = started;
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, ...args });
  session = await advance({ action: "feedback", text: "Test preference." });
  session = await advance({ action: "evaluate", decision: "accept" });
  const accepted = session;
  session = await advance({ action: "resume" });
  assert.equal(session.phase, "complete");
  assert.equal(session.evaluationRef, accepted.evaluationRef);
  setPlaying(true);
  session = await advance({ action: "resume" });
  assert.equal(session.phase, "evaluate");
  assert.equal(session.status, "requires_evaluation");
  assert.equal(session.evaluationRef, undefined);
  assert.equal(session.userDecision, undefined);
  assert.equal(session.feedbackRef, accepted.feedbackRef);
  session = await advance({ action: "evaluate", decision: "accept" });
  assert.equal(session.status, "postconditions_failed");
  setPlaying(false);
  session = await advance({ action: "evaluate", decision: "accept" });
  assert.equal(session.phase, "complete");
});
