import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProducerService } from "../src/producer-service.mjs";
import { ProducerArtifacts } from "../src/producer-artifacts.mjs";
import { ConfirmationStore } from "../src/confirmation-store.mjs";
import { withRequestSignal } from "../src/request-context.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";
import { producerToolContracts } from "../src/producer-contracts.mjs";
import { withMutationOutcome } from "../src/mutation-outcomes.mjs";

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
      return withMutationOutcome(name, args, { dryRun: false, stateVersion: version, tempo });
    }
    const fields = { get_song_musical_context: { timeSignature: { numerator: 4, denominator: 4 } },
      list_tracks: { tracks: [] }, list_scenes: { scenes: [] }, list_clips: { clips: [] }, list_arrangement_clips: { clips: [] },
      list_devices: { devices: [] }, list_device_parameters: { parameters: [] },
      get_device_parameter_edit_context: { parameters: [], editContext: {} },
      get_midi_clip_notes: { notes: [] }, get_midi_clip_notes_extended: { notes: [] },
      get_audio_clip_state: { trackId: args.trackId, clipId: args.clipId },
      get_track_mixer: { trackId: args.trackId, volume: { value: 0.85, decibels: 0 } } }[name] || {};
    return { stateVersion: version, ...fields, data: "x".repeat(12000) };
  }, readResource: async uri => ({ uri }) };
  const artifacts = new ProducerArtifacts(directory);
  const service = new ProducerService({ service: base, artifacts, config: { creative: {}, functional: {} },
    runtimeFactory: () => ({ generate: async packet => { packets.push(structuredClone(packet)); return generate(packet); } }) });
  return { service, base, artifacts, calls, packets, change: () => version++,
    reopen: () => new ProducerService({ service: base, artifacts: new ProducerArtifacts(directory), config: { creative: {}, functional: {} },
      runtimeFactory: service.runtimeFactory }) };
}

async function scopedProposal(t, operation, scope) {
  let turn = 0;
  const fixture = await setup(t, () => ++turn === 1
    ? response({ reads: [{ tool: "discover_production_tools", args: { query: operation.tool, kind: "operation" } }] })
    : response({ operations: [operation] }));
  return { ...fixture, propose: () => fixture.service.call("run_production_task", {
    projectId: "song", goal: "Change only the declared target", roles: "functional", scope }) };
}

test("change tasks cannot finish with an empty executable proposal", async t => {
  const { service, artifacts } = await setup(t, () => response());
  const task = await service.call("run_production_task", { projectId: "song", goal: "Lower the bass" });
  assert.equal(task.status, "incomplete"); assert.equal(task.stopReason, "missing_operations");
  assert.equal(task.operationCount, 0); assert.equal(task.intent, "change");
  assert.equal(artifacts.get("song", task.taskId).value.status, "incomplete");
  await assert.rejects(service.call("apply_production_operation", { projectId: "song", taskId: task.taskId,
    operationIndex: 0, expectedStateVersion: 1 }), /incomplete/);
});

async function applySessionOperation(service, session) {
  const live = await service.call("get_live_state");
  const args = { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision,
    action: "apply", expectedStateVersion: live.stateVersion };
  const planned = await service.call("advance_production_session", args);
  return service.call("advance_production_session", { ...args, dryRun: false,
    confirmationToken: planned.operation.confirmationToken, planHash: planned.operation.planHash });
}

test("a durable execution ledger preserves applied and unattempted operations across reconnect", async t => {
  const { service, reopen, calls } = await setup(t, () => response({ operations: [
    { tool: "set_tempo", args: { tempo: 110 } }, { tool: "set_tempo", args: { tempo: 115 } }
  ] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Apply two staged tempo changes", roles: "functional",
    completion: "postconditions", postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 115 }] });
  session = await service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, action: "propose" });
  assert.deepEqual(session.execution.operations.map(row => row.status), ["not_attempted", "not_attempted"]);
  session = await applySessionOperation(service, session);
  assert.deepEqual(session.execution.operations.map(row => row.status), ["applied", "not_attempted"]);
  assert.equal(session.execution.operations[0].receiptId, session.receiptId);
  assert.match(session.execution.operations[0].attemptRef, /^[a-f0-9]{64}$/);
  const next = reopen();
  session = await next.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, action: "resume" });
  assert.equal(session.operationIndex, 1); assert.equal(session.phase, "apply");
  session = await applySessionOperation(next, session);
  assert.deepEqual(session.execution.operations.map(row => row.status), ["applied", "applied"]);
  assert.deepEqual(calls.filter(call => call.name === "set_tempo" && call.args.dryRun === false).map(call => call.args.tempo), [110, 115]);
});

test("partial failures retain their ledger and require an explicit replan without replaying applied operations", async t => {
  let recovering = false;
  const { service, base, artifacts, reopen, calls, packets } = await setup(t, () => response({ operations: recovering
    ? [{ tool: "set_tempo", args: { tempo: 115 } }]
    : [{ tool: "set_tempo", args: { tempo: 110 } }, { tool: "set_tempo", args: { tempo: 115 } }] }));
  const original = base.call.bind(base);
  base.call = async (name, args = {}) => {
    if (name === "set_tempo" && args.dryRun === false && args.tempo === 115 && !recovering)
      throw Object.assign(new Error("known refusal before dispatch"), { outcome: "not_executed" });
    return original(name, args);
  };
  let session = await service.call("start_production_session", { projectId: "song", goal: "Apply staged tempo changes", roles: "functional",
    completion: "postconditions", postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 115 }] });
  const advance = (owner, action) => owner.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, action });
  session = await advance(service, "propose");
  session = await applySessionOperation(service, session);
  const firstReceipt = session.receiptId, taskId = session.taskId;
  session = await applySessionOperation(service, session);
  assert.deepEqual(session.execution.operations.map(row => row.status), ["applied", "rejected"]);
  assert.equal(session.recoveryRequired, true);
  const next = reopen();
  session = await advance(next, "resume");
  assert.equal(session.phase, "needs_inspection"); assert.equal(session.taskId, taskId);
  assert.equal(session.execution.operations[0].receiptId, firstReceipt);
  await assert.rejects(advance(next, "propose"), /phase/);
  recovering = true;
  session = await advance(next, "replan");
  assert.equal(session.phase, "inspect"); assert.equal(session.taskId, undefined);
  const recovery = artifacts.get("song", session.recoveryRef);
  assert.equal(recovery.kind, "production-recovery");
  assert.deepEqual(recovery.value.execution.operations.map(row => row.status), ["applied", "rejected"]);
  session = await advance(next, "propose");
  assert.ok(packets.at(-1).context.some(item => item.artifactId === session.recoveryRef));
  const priorRecoveryRef = session.recoveryRef;
  session = await next.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, action: "replan", text: "Only finish the change to 115 BPM",
    constraints: ["Do not repeat the earlier tempo change"] });
  assert.equal(session.phase, "inspect");
  assert.equal(session.goal, "Only finish the change to 115 BPM");
  assert.equal(artifacts.get("song", session.recoveryRef).value.previousRecoveryRef, priorRecoveryRef);
  session = await advance(next, "propose");
  assert.equal(packets.at(-1).goal, "Only finish the change to 115 BPM");
  assert.deepEqual(packets.at(-1).constraints, ["Do not repeat the earlier tempo change"]);
  session = await applySessionOperation(next, session);
  assert.equal(session.phase, "evaluate");
  assert.deepEqual(calls.filter(call => call.name === "set_tempo" && call.args.dryRun === false).map(call => call.args.tempo), [110, 115]);
});

test("a lost write reply remains uncertain even when its requested fields later match", async t => {
  const { service, base, artifacts, reopen, calls } = await setup(t, () => response({ operations: [
    { tool: "set_tempo", args: { tempo: 110 } }, { tool: "set_tempo", args: { tempo: 115 } }
  ] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Apply staged tempo changes", roles: "functional",
    completion: "postconditions", postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 115 }] });
  session = await service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, action: "propose" });
  session = await applySessionOperation(service, session);
  const original = base.call.bind(base);
  base.call = async (name, args = {}) => {
    if (name === "set_tempo" && args.dryRun === false && args.tempo === 115) {
      const pending = artifacts.session("song", session.sessionId).value;
      assert.equal(pending.phase, "execution_pending");
      assert.equal(pending.execution.operations[1].status, "execution_pending");
      assert.equal(artifacts.get("song", pending.execution.operations[1].attemptRef).kind, "operation-attempt");
      await original(name, args);
      throw Object.assign(new Error("connection lost after dispatch"), { outcome: "unknown" });
    }
    return original(name, args);
  };
  session = await applySessionOperation(service, session);
  assert.deepEqual(session.execution.operations.map(row => row.status), ["applied", "outcome_unknown"]);
  assert.equal((await service.call("get_live_state")).tempo, 115);
  const next = reopen();
  session = await next.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, action: "resume" });
  assert.equal(session.phase, "needs_inspection"); assert.equal(session.recoveryRequired, true);
  await assert.rejects(next.call("advance_production_session", { projectId: "song", sessionId: session.sessionId,
    expectedRevision: session.revision, action: "evaluate", decision: "accept" }), /phase/);
  assert.deepEqual(calls.filter(call => call.name === "set_tempo" && call.args.dryRun === false).map(call => call.args.tempo), [110, 115]);
});

test("interrupted durable attempts preserve earlier receipts and never infer the missing outcome", async t => {
  const { service, artifacts, reopen, calls } = await setup(t, () => response({ operations: [
    { tool: "set_tempo", args: { tempo: 110 } }, { tool: "set_tempo", args: { tempo: 115 } }
  ] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Staged changes", roles: "functional" });
  session = await service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, action: "propose" });
  session = await applySessionOperation(service, session);
  const saved = artifacts.session("song", session.sessionId);
  artifacts.advanceSession("song", session.sessionId, saved.value.revision, { ...saved.value, phase: "execution_pending",
    execution: { ...saved.value.execution, operations: saved.value.execution.operations.map((row, index) => index === 1
      ? { ...row, status: "execution_pending" } : row) } });
  const next = reopen(), pending = await next.call("get_production_session", { projectId: "song", sessionId: session.sessionId });
  const resumed = await next.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: pending.revision, action: "resume" });
  assert.equal(resumed.phase, "needs_inspection");
  assert.deepEqual(resumed.execution.operations.map(row => row.status), ["applied", "outcome_unknown"]);
  assert.equal(resumed.execution.operations[0].receiptId, session.receiptId);
  assert.deepEqual(calls.filter(call => call.name === "set_tempo" && call.args.dryRun === false).map(call => call.args.tempo), [110]);
});

test("legacy execution summaries label missing earlier receipts as unrecorded", async t => {
  const { service, artifacts } = await setup(t, () => response({ operations: [110, 115, 118].map(tempo => ({ tool: "set_tempo", args: { tempo } })) }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Staged changes", roles: "functional" });
  session = await service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, action: "propose" });
  session = await applySessionOperation(service, session); session = await applySessionOperation(service, session);
  const saved = artifacts.session("song", session.sessionId);
  artifacts.advanceSession("song", session.sessionId, saved.value.revision, { ...saved.value, execution: undefined });
  const legacy = await service.call("get_production_session", { projectId: "song", sessionId: session.sessionId });
  assert.deepEqual(legacy.execution.operations.map(row => row.status), ["unrecorded", "applied", "not_attempted"]);
  assert.equal(legacy.execution.operations[1].receiptId, session.receiptId);
});

test("inspection tasks expose reads without granting operation discovery or proposals", async t => {
  const { service, packets } = await setup(t, () => response());
  const task = await service.call("run_production_task", { projectId: "song", goal: "Inspect", intent: "inspect" });
  assert.equal(task.status, "observed"); assert.equal(task.operationCount, 0);
  assert.deepEqual(packets[0].tools.operations, []);
  for (const result of [response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }),
    response({ reads: [{ tool: "discover_production_tools", args: { query: "set_tempo", kind: "operation" } }] })]) {
    service.runtimeFactory = () => ({ generate: async () => result });
    await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "Inspect", intent: "inspect" }), /inspection/);
  }
});

test("a no-change result requires fresh caller-owned criteria and records its evidence", async t => {
  for (const expected of [120, 100]) {
    const { service, calls, artifacts } = await setup(t, () => response());
    const task = await service.call("run_production_task", { projectId: "song", goal: "Use the required tempo",
      postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected }] });
    assert.equal(task.status, expected === 120 ? "no_change_needed" : "incomplete");
    assert.equal(task.operationCount, 0); assert.ok(task.completionRef);
    const evidence = artifacts.get("song", task.completionRef).value;
    assert.equal(evidence.checks[0].matches, expected === 120);
    assert.equal(artifacts.get("song", evidence.checks[0].observationRef).value.observed.tempo, 120);
    assert.ok(calls.filter(call => call.name === "get_live_state").length >= 4);
    assert.equal(calls.some(call => call.name === "set_tempo"), false);
  }
});

test("specialist-selected checks cannot certify a requested no-op", async t => {
  const { service } = await setup(t, () => response({ checks: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 120 }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Set a different tempo" });
  assert.equal(task.status, "incomplete"); assert.equal(task.stopReason, "missing_operations");
});

test("internal postcondition reads cannot certify malformed observations", async t => {
  const { service, base } = await setup(t, () => response());
  const original = base.call;
  base.call = (name, args) => name === "get_track_mixer" ? { stateVersion: 1, trackId: "track-0", volume: null } : original(name, args);
  const task = await service.call("run_production_task", { projectId: "song", goal: "Resolve the required mixer state",
    postconditions: [{ tool: "get_track_mixer", args: { trackId: "track-0" }, path: ["volume"], expected: null }] });
  assert.equal(task.status, "incomplete"); assert.equal(task.stopReason, "postconditions_unavailable");
});

test("internal planning and execution validate original receipts and retain invalid write evidence", async t => {
  for (const execute of [false, true]) {
    const { service, base, artifacts } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
    const task = await service.call("run_production_task", { projectId: "song", goal: "Set tempo" });
    const original = base.call; let writes = 0;
    base.call = (name, args) => {
      if (name === "set_tempo") { writes++; return { dryRun: !execute }; }
      return original(name, args);
    };
    const args = { projectId: "song", taskId: task.taskId, operationIndex: 0, expectedStateVersion: 1 };
    if (!execute) await assert.rejects(service.call("apply_production_operation", args), /invalid tool result/);
    else {
      const receipt = await service.call("apply_production_operation", { ...args, dryRun: false, confirmationToken: "token", planHash: "hash" });
      assert.equal(receipt.status, "outcome_unknown"); assert.ok(receipt.resultRef);
      assert.deepEqual(artifacts.get("song", receipt.resultRef).value, { dryRun: false });
    }
    assert.equal(writes, 1);
  }
});

test("unavailable or changing no-op evidence cannot complete a change task", async t => {
  for (const unavailable of [false, true]) {
    const { service, base, change } = await setup(t, () => response());
    const original = base.call;
    base.call = async (name, args) => {
      if (name === "get_track_mixer") {
        if (unavailable) throw new Error("target unavailable");
        change(); return { volume: -12 };
      }
      return original(name, args);
    };
    const task = await service.call("run_production_task", { projectId: "song", goal: "Set volume",
      postconditions: [{ tool: "get_track_mixer", args: { trackId: "track-0" }, path: ["volume"], expected: -12 }] });
    assert.equal(task.status, unavailable ? "incomplete" : "stale_context");
    assert.equal(task.operationCount, 0);
  }
});

for (const name of ["run_production_task", "start_production_session"])
  test(`${name} rejects malformed or inconsistent scopes before observation`, async t => {
    for (const scope of [
      { clipId: "trak-0:clip-0" }, { deviceId: "device-0" }, { trackId: "track-00" },
      { trackId: "track-0", clipId: "track-1:clip-0" },
      { trackId: "track-0", deviceId: "track-1:device-0" },
      { clipId: "track-0:clip-0", deviceId: "track-1:device-0" },
      { trackId: "track-0", clipId: "track-0:clip-00" },
      { trackId: "track-0", deviceId: "track-0:device-0/chain-00/device-0" }
    ]) {
      const { service, calls, packets } = await setup(t, () => response());
      await assert.rejects(service.call(name, { projectId: "song", goal: "Inspect the exact target", roles: "functional", scope }), /scope/);
      assert.equal(calls.length, 0);
      assert.equal(packets.length, 0);
    }
  });

test("clip-only task scopes retain their canonical owner boundary", async t => {
  for (const clipId of ["track-0:clip-0", "track-0:arrangement-clip-0"]) {
    const { propose } = await scopedProposal(t, { tool: "set_track_mixer", args: { trackId: "track-1", mute: true } }, { clipId });
    await assert.rejects(propose(), /scope/);
  }
  const { propose } = await scopedProposal(t, { tool: "set_clip_timing", args: { trackId: "track-0", clipId: "track-0:clip-0", mute: true } }, { clipId: "track-0:clip-0" });
  assert.equal((await propose()).operationCount, 1);
});

for (const operation of [
  { tool: "set_bulk_track_mixer", args: { trackIds: ["track-1"], mute: true } },
  { tool: "set_crossfader_state", args: { assignments: [{ trackId: "track-1", side: "A" }] } },
  { tool: "duplicate_clip", args: { trackId: "track-0", clipId: "track-0:clip-0", destinationTrackId: "track-1", destinationClipId: "track-1:clip-1" } },
  { tool: "rename_session_object", args: { targetType: "track", targetId: "track-1", name: "Other track" } },
  { tool: "set_selected_parameter", args: { expectedSelectionToken: "selection", value: 0.5 } }
]) test(`scoped proposals reject unresolved or out-of-scope targets in ${operation.tool}`, async t => {
  const { propose, calls } = await scopedProposal(t, operation, { trackId: "track-0" });
  await assert.rejects(propose(), /scope/);
  assert.equal(calls.some(call => call.name === operation.tool), false);
});

for (const [name, args] of [
  ["source", { trackId: "track-0", sourceClipId: "track-0:clip-8", variants: [{ clipId: "track-0:clip-1", name: "Copy" }] }],
  ["destination owner", { trackId: "track-0", sourceClipId: "track-0:clip-0", variants: [{ clipId: "track-1:clip-1", name: "Copy" }] }]
]) test(`MIDI copy proposals validate the ${name} against scope`, async t => {
  const { propose } = await scopedProposal(t, { tool: "duplicate_midi_clip_variations", args }, { trackId: "track-0", clipId: "track-0:clip-0" });
  await assert.rejects(propose(), /scope/);
});

test("scoped copies preserve the source boundary while allowing a new slot on the same track", async t => {
  const { propose } = await scopedProposal(t, { tool: "duplicate_midi_clip_variations", args: {
    trackId: "track-0", sourceClipId: "track-0:clip-0", variants: [{ clipId: "track-0:clip-1", name: "Copy" }] }
  }, { trackId: "track-0", clipId: "track-0:clip-0" });
  assert.equal((await propose()).operationCount, 1);
});

test("a scoped send may reference a Return without modifying that Return", async t => {
  const { propose } = await scopedProposal(t, { tool: "set_track_send_db", args: {
    trackId: "track-0", returnTrackId: "return-0", sendId: "send-0", sendDb: -12 }
  }, { trackId: "track-0" });
  assert.equal((await propose()).operationCount, 1);
});

test("saved proposals are checked for array scope escapes again before planning", async t => {
  const operation = { tool: "set_bulk_track_mixer", args: { trackIds: ["track-1"], mute: true } };
  const { propose, service, artifacts, calls } = await scopedProposal(t, operation, {});
  const task = await propose();
  const taskId = artifacts.put("song", "task", { ...artifacts.get("song", task.taskId).value, scope: { trackId: "track-0" } });
  await assert.rejects(service.call("apply_production_operation", { projectId: "song", taskId,
    operationIndex: 0, expectedStateVersion: 1 }), /scope/);
  assert.equal(calls.some(call => call.name === operation.tool), false);
});

test("saved malformed scopes are rejected before contacting an unavailable Live", async t => {
  const { service, base, artifacts } = await setup(t, () => response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] }));
  const task = await service.call("run_production_task", { projectId: "song", goal: "Set tempo", roles: "functional" });
  const saved = artifacts.get("song", task.taskId).value;
  base.call = async () => { throw new Error("Live is unavailable"); };
  for (const scope of [{ clipId: "trak-0:clip-0" }, { trackId: "track-0", deviceId: "track-1:device-0" }]) {
    const taskId = artifacts.put("song", "task", { ...saved, scope });
    await assert.rejects(service.call("apply_production_operation", { projectId: "song", taskId,
      operationIndex: 0, expectedStateVersion: 1 }), /scope/);
  }
});

test("bulk observation targets obey the same owner scope as proposals", async t => {
  let turn = 0;
  const { service, calls } = await setup(t, () => ++turn === 1
    ? response({ reads: [{ tool: "discover_production_tools", args: { query: "get_track_signal_activity", kind: "read" } }] })
    : response({ reads: [{ tool: "get_track_signal_activity", args: { trackIds: ["track-1"] } }] }));
  await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "Inspect only track zero",
    roles: "functional", scope: { trackId: "track-0" } }), /scope/);
  assert.equal(calls.some(call => call.name === "get_track_signal_activity"), false);
});

test("device aliases cannot address a different device in a scoped proposal", async t => {
  const { propose } = await scopedProposal(t, { tool: "map_rack_macro_to_parameter", args: {
    trackId: "track-0", deviceId: "track-0:device-0", targetDeviceId: "track-0:device-1", parameterId: "parameter-0", macroIndex: 0 }
  }, { trackId: "track-0", deviceId: "track-0:device-0" });
  await assert.rejects(propose(), /scope/);
});

test("destination chains cannot escape an exact device scope", async t => {
  const { propose, calls } = await scopedProposal(t, { tool: "move_device_to_chain", args: {
    trackId: "track-0", deviceId: "track-0:device-0", targetTrackId: "track-0",
    targetChainId: "track-0:device-1/chain-0", targetPosition: 0 }
  }, { trackId: "track-0", deviceId: "track-0:device-0" });
  await assert.rejects(propose(), /scope/);
  assert.equal(calls.some(call => call.name === "move_device_to_chain"), false);
});

for (const [clipId, allowed] of [["track-0:arrangement-clip-0", true], ["track-0:arrangement-clip-1", false]])
  test(`Arrangement color targets enforce exact clip scope: ${clipId}`, async t => {
    const { propose } = await scopedProposal(t, { tool: "set_live_object_colors", args: {
      changes: [{ objectId: clipId, color: "#ff0000" }], expectedSetFingerprint: "set-a" }
    }, { trackId: "track-0", clipId: "track-0:arrangement-clip-0" });
    if (allowed) assert.equal((await propose()).operationCount, 1);
    else await assert.rejects(propose(), /scope/);
  });

test("imported feel provenance is not treated as another Live mutation target", async t => {
  const template = { format: "cavi-audio-feel-v1", gridBeats: 0.25, bars: 1, barBeats: 4,
    cycleBeats: 4, slotCount: 16, nativeGrooveId: null,
    source: { trackId: "track-1", clipId: "track-1:clip-0", stateVersion: 4, sourcePath: "/audio/source.wav" },
    slots: [{ slot: 1, hitCount: 1, reliableTimingHits: 1, meanOffsetBeats: 0.04, meanStrength: 0.7 }], limitation: "Source timing only." };
  const { propose } = await scopedProposal(t, { tool: "apply_midi_feel_template", args: {
    trackId: "track-0", clipId: "track-0:clip-0", template, timingAmount: 1, velocityAmount: 0 }
  }, { trackId: "track-0", clipId: "track-0:clip-0" });
  assert.equal((await propose()).operationCount, 1);
});

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
  assert.equal(result.status,'incomplete');assert.equal(result.readsUsed,0);assert.equal(packets.length,2);
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
  assert.equal(result.status,'incomplete');assert.equal(packets[0].workflow.workflow,'resume-session-work');
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

test("deferred schemas preserve a guarded proposal with a smaller initial context", async t => {
  const { service, packets, calls, artifacts } = await setup(t, packet => {
    const turn = packet.progress.turn;
    if (turn === 1) return response({ reads: [{ tool: "discover_production_tools", args: { query: "get_track_mixer", kind: "read" } }] });
    if (turn === 2) return response({ reads: [{ tool: "get_track_mixer", args: { trackId: "track-0" } }] });
    if (turn === 3) return response({ reads: [{ tool: "discover_production_tools", args: { query: "set_tempo", kind: "operation" } }] });
    return response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] });
  });
  service.config.functional.toolDiscovery = "deferred";
  const task = await service.call("run_production_task", { projectId: "song", goal: "Inspect the mixer and propose 100 BPM" });
  assert.equal(task.status, "proposed"); assert.equal(task.operationCount, 1);
  assert.equal(task.readsUsed, 1); assert.equal(task.discoveriesUsed, 2);
  assert.deepEqual(packets[0].tools.reads.slice(0, 3).map(tool => tool.name), ["get_live_state", "get_selection_context", "get_song_musical_context"]);
  assert.ok(packets[0].tools.operations.every(tool => !tool.inputSchema.properties.confirmationToken));
  assert.deepEqual(packets[0].tools.available.reads, Object.keys(toolContracts).filter(name =>
    !Object.hasOwn(producerToolContracts, name) && toolContracts[name].annotations.readOnlyHint));
  assert.deepEqual(packets[0].tools.available.operations, Object.keys(toolContracts).filter(name =>
    !Object.hasOwn(producerToolContracts, name) && toolContracts[name].inputSchema.properties.expectedStateVersion && toolContracts[name].inputSchema.properties.dryRun));
  assert.equal(packets[2].progress.readsRemaining, 7);
  assert.equal(packets[3].progress.discoveriesRemaining, 6);
  assert.equal(packets[3].progress.maxTurns, 6);
  assert.equal(calls.some(call => call.name === "set_tempo"), false);
  const planned = await service.call("apply_production_operation", { projectId: "song", taskId: task.taskId,
    operationIndex: 0, expectedStateVersion: 1 });
  assert.equal(planned.status, "planned");
  const plan = artifacts.get("song", planned.planRef).value;
  assert.equal(plan.dryRun, true); assert.ok(planned.confirmationToken); assert.ok(planned.planHash);
  const eager = await setup(t, () => response());
  await eager.service.call("run_production_task", { projectId: "song", goal: "Inspect the mixer and propose 100 BPM" });
  assert.ok(Buffer.byteLength(JSON.stringify(packets[0].tools)) < Buffer.byteLength(JSON.stringify(eager.packets[0].tools)));
});

test("deferred specialists cannot use schemas before loading them or escape scope", async t => {
  for (const result of [
    response({ reads: [{ tool: "get_track_mixer", args: { trackId: "track-0" } }] }),
    response({ operations: [{ tool: "set_tempo", args: { tempo: 100 } }] })
  ]) {
    const { service } = await setup(t, () => result);
    service.config.functional.toolDiscovery = "deferred";
    await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "Inspect" }), /not allowed/);
  }
  const { service, calls } = await setup(t, packet => packet.progress.turn === 1
    ? response({ reads: [{ tool: "discover_production_tools", args: { query: "set_track_volume_db", kind: "operation" } }] })
    : response({ operations: [{ tool: "set_track_volume_db", args: { trackId: "track-1", volumeDb: -12 } }] }));
  service.config.functional.toolDiscovery = "deferred";
  await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "Lower the target", scope: { trackId: "track-0" } }), /scope/);
  assert.equal(calls.some(call => call.name === "set_track_volume_db"), false);
});

test("deferred discovery has its own bounded budget and preserves eight observation reads", async t => {
  const { service } = await setup(t, packet => packet.progress.turn === 1
    ? response({ reads: [{ tool: "discover_production_tools", args: { query: "get_track_mixer", kind: "read" } }] })
    : packet.progress.turn < 4
      ? response({ reads: Array.from({ length: 4 }, () => ({ tool: "get_live_state", args: {} })) }) : response());
  service.config.functional.toolDiscovery = "deferred";
  const task = await service.call("run_production_task", { projectId: "song", goal: "Inspect", intent: "inspect" });
  assert.equal(task.status, "observed"); assert.equal(task.readsUsed, 8); assert.equal(task.discoveriesUsed, 1);
  const limited = await setup(t, () => response({ reads: Array.from({ length: 4 }, () => ({
    tool: "discover_production_tools", args: { query: "mixer", kind: "read" }
  })) }));
  limited.service.config.functional.toolDiscovery = "deferred";
  const exhausted = await limited.service.call("run_production_task", { projectId: "song", goal: "Inspect", intent: "inspect" });
  assert.equal(exhausted.status, "budget_exhausted"); assert.equal(exhausted.stopReason, "discovery_limit");
  assert.equal(exhausted.discoveriesUsed, 8); assert.equal(exhausted.readsUsed, 0); assert.equal(exhausted.operationCount, 0);
});

test("deferred roles retain caller check schemas without sharing newly loaded permissions", async t => {
  const { service, packets } = await setup(t, packet => packet.role === "creative" && packet.progress.turn === 1
    ? response({ reads: [{ tool: "discover_production_tools", args: { query: "get_track_signal_activity", kind: "read" } }] })
    : response());
  for (const role of ["creative", "functional"]) service.config[role].toolDiscovery = "deferred";
  const task = await service.call("run_production_task", { projectId: "song", goal: "Inspect", roles: "both",
    postconditions: [{ tool: "get_track_mixer", args: { trackId: "track-0" }, path: ["volume", "decibels"], expected: -12 }] });
  assert.equal(task.status, "incomplete");
  for (const packet of packets) assert.ok(packet.tools.reads.some(tool => tool.name === "get_track_mixer"));
  assert.deepEqual(packets[0].tools.available.operations, []);
  assert.equal(packets.at(-1).tools.reads.some(tool => tool.name === "get_track_signal_activity"), false);
  assert.equal(packets.at(-1).progress.discoveriesRemaining, 7);
  service.runtimeFactory = () => ({ generate: async packet => packet.role === "creative"
    ? packet.progress.turn === 1 ? response({ reads: [{ tool: "discover_production_tools", args: { query: "get_track_signal_activity", kind: "read" } }] }) : response()
    : response({ reads: [{ tool: "get_track_signal_activity", args: { trackId: "track-0" } }] }) });
  await assert.rejects(service.call("run_production_task", { projectId: "song", goal: "Inspect", roles: "both" }), /not allowed/);
});

test("deferred mode retains creative restrictions and a bounded model-turn limit", async t => {
  const creative = await setup(t, () => response({ reads: [{ tool: "discover_production_tools", args: { query: "set_tempo", kind: "operation" } }] }));
  creative.service.config.creative.toolDiscovery = "deferred";
  await assert.rejects(creative.service.call("run_production_task", { projectId: "song", goal: "Inspect", roles: "creative" }), /creative operation discovery/);
  const limited = await setup(t, () => response({ reads: [{ tool: "get_live_state", args: {} }] }));
  limited.service.config.functional.toolDiscovery = "deferred";
  const task = await limited.service.call("run_production_task", { projectId: "song", goal: "Inspect" });
  assert.equal(task.status, "budget_exhausted"); assert.equal(task.stopReason, "model_turn_limit");
  assert.equal(task.turnRefs.length, 6); assert.equal(task.readsUsed, 5); assert.equal(task.operationCount, 0);
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
  const task = await service.call("run_production_task", { projectId: "song", goal: "Plan this phase", intent: "inspect", roles: "both" });
  assert.equal(task.status, "observed"); assert.equal(task.readsUsed, 1);
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
  const task = await service.call("run_production_task", { projectId: "song", goal: "Review the previous reply", intent: "inspect" });
  assert.equal(task.status, "observed");assert.equal(task.readsUsed, 2);
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
  assert.equal(task.status, "incomplete");assert.equal(task.operationCount, 0);assert.equal(task.readsUsed, 0);
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
  assert.equal(task.status, "incomplete");
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
  const result=await service.call('run_production_task',{projectId:'song',goal:'Inspect this effect before comparing bypass',intent:'inspect',roles:'functional',
    workflow:{name:'compare-effect-bypass',arguments:{request:'Compare the named EQ and preserve playback'}}});
  assert.equal(result.status,'observed');
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
  base.call = (name, args) => name === "set_tempo" ? Promise.resolve(withMutationOutcome(name, args, { dryRun: false, pendingUserAction: true })) : original(name, args);
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

test('functional sessions complete caller criteria without a creative role or invented listening feedback', async t => {
  const { service, artifacts, packets, reopen } = await setup(t, () => response({
    operations: [{ tool: 'set_tempo', args: { tempo: 100 } }],
    checks: [{ tool: 'get_live_state', args: {}, path: ['tempo'], expected: 99 }]
  }));
  delete service.config.creative;
  let session = await service.call('start_production_session', { projectId: 'song', goal: 'Set tempo to 100',
    roles: 'functional', completion: 'postconditions', postconditions: [
      { tool: 'get_live_state', args: {}, path: ['tempo'], expected: 100 }
    ] });
  const advance = async args => session = await service.call('advance_production_session', {
    projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, ...args
  });
  assert.equal(session.roles, 'functional'); assert.equal(session.completion, 'postconditions');
  await advance({ action: 'propose' }); assert.equal(session.phase, 'apply');
  assert.deepEqual(packets.map(p => p.role), ['functional']);
  const plan = await advance({ action: 'apply', expectedStateVersion: 1 });
  assert.equal(plan.operation.status, 'planned');
  await advance({ action: 'apply', expectedStateVersion: 1, dryRun: false,
    confirmationToken: plan.operation.confirmationToken, planHash: plan.operation.planHash });
  assert.equal(session.phase, 'evaluate'); assert.equal(session.operation.status, 'applied');
  await advance({ action: 'evaluate', decision: 'accept' });
  assert.equal(session.phase, 'complete'); assert.equal(session.status, 'postconditions_met');
  assert.equal(session.userDecision, undefined); assert.equal(session.feedbackRef, undefined);
  assert.equal(session.audibleQualityVerified, false);
  const evaluation = artifacts.get('song', session.evaluationRef).value;
  assert.equal(evaluation.basis, 'postconditions'); assert.equal(evaluation.checks.length, 1);
  assert.equal(evaluation.checks[0].matches, true); assert.equal(evaluation.feedbackRef, undefined);
  const resumed = await reopen().call('advance_production_session', {
    projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, action: 'resume'
  });
  assert.equal(resumed.phase, 'evaluate'); assert.equal(resumed.status, 'requires_evaluation');
  assert.equal(resumed.evaluationRef, undefined); assert.equal(resumed.roles, 'functional');
  assert.equal(resumed.completion, 'postconditions'); assert.equal(resumed.stateChanged, false);
});

test('postcondition completion requires caller criteria before any observation or generation', async t => {
  for (const args of [{ completion: 'postconditions' }, { completion: 'postconditions', postconditions: [] },
    { completion: 'invented' }, { roles: 'creative' }]) {
    const { service, calls, packets } = await setup(t, () => response());
    await assert.rejects(service.call('start_production_session', { projectId: 'song', goal: 'Set tempo', ...args }),
      /postconditions|criteria|schema|arguments/);
    assert.equal(calls.length, 0); assert.equal(packets.length, 0);
  }
});

test('empty functional proposals cannot complete failed caller criteria and can be revised without feedback', async t => {
  const { service, artifacts } = await setup(t, () => response());
  let session = await service.call('start_production_session', { projectId: 'song', goal: 'Set tempo to 100',
    roles: 'functional', completion: 'postconditions', postconditions: [
      { tool: 'get_live_state', args: {}, path: ['tempo'], expected: 100 }
    ] });
  const advance = async args => session = await service.call('advance_production_session', {
    projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, ...args
  });
  await advance({ action: 'propose' }); assert.equal(session.phase, 'inspect');
  assert.equal(session.status, 'incomplete');
  assert.equal(artifacts.get('song', session.task.completionRef).value.checks[0].matches, false);
  await assert.rejects(advance({ action: 'evaluate', decision: 'accept' }), /invalid/);
  assert.equal(session.userDecision, undefined);
  assert.equal(session.phase, 'inspect'); assert.equal(session.evaluationRef, undefined);
  assert.equal(session.userDecision, undefined);
  await advance({ action: 'propose' }); assert.equal(session.phase, 'inspect');
});

test('caller-checked sessions can complete an already satisfied task in either role flow without writes', async t => {
  for (const roles of ['both', 'functional']) {
    const { service, calls, packets } = await setup(t, packet => response(packet.role === 'creative'
      ? { alternatives: [{ name: 'Keep', description: 'Keep the existing tempo.' }] } : {}));
    let session = await service.call('start_production_session', { projectId: 'song', goal: 'Keep tempo 120', roles,
      completion: 'postconditions', postconditions: [{ tool: 'get_live_state', args: {}, path: ['tempo'], expected: 120 }] });
    const advance = async args => session = await service.call('advance_production_session', {
      projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, ...args
    });
    await advance({ action: 'propose' });
    if (roles === 'both') { await advance({ action: 'choose', alternativeIndex: 0 }); await advance({ action: 'propose' }); }
    assert.equal(session.phase, 'evaluate'); assert.equal(session.receiptId, undefined);
    await advance({ action: 'evaluate', decision: 'accept' });
    assert.equal(session.phase, 'complete'); assert.equal(session.status, 'postconditions_met');
    assert.equal(session.userDecision, undefined); assert.equal(session.audibleQualityVerified, false);
    assert.equal(calls.some(call => call.name === 'set_tempo'), false);
    assert.deepEqual(packets.map(p => p.role), roles === 'both' ? ['creative', 'functional'] : ['functional']);
  }
});

test('functional listening sessions still require actual feedback and postcondition sessions refuse stale acceptance', async t => {
  for (const completion of ['listening', 'postconditions']) {
    const { service, base } = await setup(t, () => response());
    let session = await service.call('start_production_session', { projectId: 'song', goal: 'Keep tempo 120',
      roles: 'functional', completion, postconditions: [{ tool: 'get_live_state', args: {}, path: ['tempo'], expected: 120 }] });
    const advance = async args => session = await service.call('advance_production_session', {
      projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, ...args
    });
    await advance({ action: 'propose' });
    if (completion === 'listening') {
      assert.equal(session.phase, 'audition');
      await assert.rejects(advance({ action: 'evaluate', decision: 'accept' }), /feedback|phase/);
      await advance({ action: 'feedback', text: 'I prefer the current tempo.' });
    }
    const original = base.call.bind(base);
    base.call = async (name, args) => name === 'get_live_state'
      ? { ...await original(name, args), tempo: 121 } : original(name, args);
    await assert.rejects(advance({ action: 'evaluate', decision: 'accept' }), /state changed/);
    await advance({ action: 'resume' }); assert.equal(session.phase, 'inspect');
  }
});

test('resume reopens checked acceptance when manual playback changes without advancing the bridge version', async t => {
  const { service, base } = await setup(t, () => response());
  let playing = false; const original = base.call.bind(base);
  base.call = async (name, args) => name === 'get_live_state'
    ? { ...await original(name, args), isPlaying: playing } : original(name, args);
  let session = await service.call('start_production_session', { projectId: 'song', goal: 'Keep playback stopped',
    roles: 'functional', completion: 'postconditions', postconditions: [{ tool: 'get_live_state', args: {}, path: ['isPlaying'], expected: false }] });
  const advance = async args => session = await service.call('advance_production_session', {
    projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, ...args
  });
  await advance({ action: 'propose' }); await advance({ action: 'evaluate', decision: 'accept' });
  assert.equal(session.status, 'postconditions_met'); const basis = session.basis;
  playing = true; await advance({ action: 'resume' });
  assert.equal(session.phase, 'evaluate'); assert.equal(session.status, 'requires_evaluation');
  assert.equal(session.evaluationRef, undefined); assert.equal(session.userDecision, undefined);
  assert.deepEqual(session.basis, basis); assert.equal(session.stateChanged, false);
  await advance({ action: 'evaluate', decision: 'accept' });
  assert.equal(session.phase, 'evaluate'); assert.equal(session.status, 'postconditions_failed');
});

test('checked completion retains completed work across playback versions and rechecks acceptance', async t => {
  const { service, change, artifacts } = await setup(t, () => response());
  let session = await service.call('start_production_session', { projectId: 'song', goal: 'Keep tempo 120',
    roles: 'functional', completion: 'postconditions', postconditions: [{ tool: 'get_live_state', args: {}, path: ['tempo'], expected: 120 }] });
  const advance = async args => session = await service.call('advance_production_session', {
    projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, ...args
  });
  await advance({ action: 'propose' }); const taskId = session.taskId;
  change(); await advance({ action: 'evaluate', decision: 'accept' });
  assert.equal(session.status, 'postconditions_met'); assert.equal(session.basis.stateVersion, 2);
  const priorEvaluation = session.evaluationRef;
  change(); await advance({ action: 'resume' });
  assert.equal(session.phase, 'evaluate'); assert.equal(session.status, 'requires_evaluation');
  assert.equal(session.taskId, taskId); assert.equal(session.evaluationRef, undefined);
  assert.equal(session.feedbackRef, undefined); assert.equal(session.userDecision, undefined);
  await advance({ action: 'evaluate', decision: 'accept' });
  assert.equal(session.status, 'postconditions_met'); assert.equal(session.basis.stateVersion, 3);
  assert.equal(artifacts.get('song', priorEvaluation).value.checks[0].matches, true);
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
  assert.equal(resumed.phase, "needs_inspection");
  assert.equal(resumed.status, "requires_recovery");
  assert.equal(resumed.recoveryRequired, true);
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
  assert.equal(session.phase, "inspect");
  assert.equal(session.status, "incomplete");
  await assert.rejects(advance({ action: "feedback", text: "I prefer this version." }), /invalid/);
  await assert.rejects(advance({ action: "evaluate", decision: "accept" }), /invalid/);
  assert.equal(artifacts.get("song", session.task.completionRef).value.checks[0].matches, false);
});

test("listening feedback informs both specialists when the user requests another revision", async t => {
  const { service, packets } = await setup(t, () => response({ alternatives: [{ name: "Sparse", description: "Less busy" }] }));
  let session = await service.call("start_production_session", { projectId: "song", goal: "Keep tempo 120",
    postconditions: [{ tool: "get_live_state", args: {}, path: ["tempo"], expected: 120 }] });
  const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, ...args });
  for (const args of [{ action: "propose" }, { action: "choose", alternativeIndex: 0 }, { action: "propose" },
    { action: "feedback", text: "Keep the syncopation but reduce the density." }, { action: "evaluate", decision: "revise" },
    { action: "propose" }, { action: "choose", alternativeIndex: 0 }, { action: "propose" }]) session = await advance(args);
  for (const packet of packets.slice(-2)) assert.ok(packet.context.some(item => item.kind === "feedback" && item.text.includes("Keep the syncopation")));
});

async function musicalSession(t, scope = {}) {
  const setupResult = await setup(t, () => response({ alternatives: [{ name: 'Keep', description: 'Keep the phrase.' }] }));
  const { service, base } = setupResult, original = base.call.bind(base);
  const state = { tempo: 120, playing: false, selection: 'track-0', musical: {
    timeSignature: { numerator: 4, denominator: 4 }, key: { rootNote: 0, scaleName: 'Major', scaleMode: true },
    quantization: { clipTrigger: { value: 4 }, midiRecording: { value: 0 } },
    groove: { amount: .5, swingAmount: 0, pool: [] }, loop: { enabled: false, startBeats: 0, lengthBeats: 16 }
  } };
  base.call = async (name, args) => {
    if (name === 'get_live_state') return { ...await original(name, args), tempo: state.tempo, isPlaying: state.playing };
    if (name === 'get_selection_context') return { trackId: state.selection };
    if (name === 'get_song_musical_context') return structuredClone({ stateVersion: 1, ...state.musical });
    if (name === 'get_set_mixer') return { master: { volume: .8 }, returns: [{ id: 'return-0', volume: .7 }] };
    return original(name, args);
  };
  let session = await service.call('start_production_session', { projectId: 'song', goal: 'Keep the phrase in the song context', scope });
  const advance = async args => session = await service.call('advance_production_session', {
    projectId: 'song', sessionId: session.sessionId, expectedRevision: session.revision, ...args
  });
  return { ...setupResult, state, started: session, advance };
}

test('manual tempo changes invalidate durable choices for every owner without a bridge version change', async t => {
  for (const scope of [{}, { trackId: 'track-0' }, { trackId: 'return-0' }, { trackId: 'master' }]) {
    const { state, advance, packets, artifacts, started } = await musicalSession(t, scope);
    await advance({ action: 'propose' });
    const count = packets.length;
    state.tempo = 97;
    await assert.rejects(advance({ action: 'choose', alternativeIndex: 0 }), /state changed/);
    const resumed = await advance({ action: 'resume' });
    assert.equal(resumed.stateChanged, true); assert.equal(resumed.phase, 'inspect');
    assert.equal(resumed.taskId, undefined); assert.equal(packets.length, count);
    const before = artifacts.get('song', started.targetRef).value.observations;
    const after = artifacts.get('song', resumed.targetRef).value.observations;
    assert.equal(before.song.tempo, 120); assert.equal(after.song.tempo, 97);
    assert.deepEqual(resumed.basis, started.basis);
  }
});

test('durable sessions bind meter, configured key, launch quantization, groove and Arrangement loop', async t => {
  for (const change of [s => s.timeSignature.numerator = 3, s => s.key.rootNote = 7,
    s => s.quantization.clipTrigger.value = 5, s => s.quantization.midiRecording.value = 2,
    s => s.groove.amount = .7, s => s.groove.pool.push({ id: 'groove-0', name: 'Swing', timingAmount: .5 }),
    s => s.loop.enabled = true, s => s.loop.startBeats = 8, s => s.loop.lengthBeats = 32]) {
    const { state, advance, artifacts, started } = await musicalSession(t, { trackId: 'track-0' });
    await advance({ action: 'propose' }); change(state.musical);
    await assert.rejects(advance({ action: 'choose', alternativeIndex: 0 }), /state changed/);
    const resumed = await advance({ action: 'resume' });
    assert.equal(resumed.stateChanged, true); assert.equal(resumed.phase, 'inspect');
    assert.equal(resumed.taskId, undefined);
    assert.notDeepEqual(artifacts.get('song', resumed.targetRef).value.observations,
      artifacts.get('song', started.targetRef).value.observations);
  }
});

test('musical changes during durable observation refuse a mixed snapshot', async t => {
  for (const kind of ['tempo', 'musical']) {
    const { service, base } = await setup(t, () => response());
    const original = base.call.bind(base); let reads = 0;
    base.call = async (name, args) => {
      if (kind === 'tempo' && name === 'get_live_state') return { ...await original(name, args), tempo: ++reads === 1 ? 120 : 97 };
      if (kind === 'musical' && name === 'get_song_musical_context') return { stateVersion: 1, timeSignature: { numerator: ++reads === 1 ? 4 : 3, denominator: 4 } };
      return original(name, args);
    };
    await assert.rejects(service.call('start_production_session', { projectId: 'song', goal: 'Keep the phrase' }), /changed/);
  }
});

test('selection and playback changes preserve durable musical proposals', async t => {
  const { state, advance, started } = await musicalSession(t, { trackId: 'track-0' });
  await advance({ action: 'propose' }); state.playing = true; state.selection = 'track-4';
  const resumed = await advance({ action: 'resume' });
  assert.equal(resumed.stateChanged, false); assert.equal(resumed.phase, 'choose');
  assert.equal(resumed.targetRef, started.targetRef);
});

test('durable Return and Main sessions capture the exact bus and resume after owned edits',async t=>{
 for(const owner of ['return-0','master']){
  const {service,base,artifacts,packets}=await setup(t,()=>response({alternatives:[{name:'Keep',description:'Preserve this bus.'}]}));
  let own=.8,other=.7;
  const original=base.call.bind(base);
  base.call=async(name,args)=>{
   if(name==='get_track_mixer')throw Error('ordinary mixer read must not target a bus');
   if(name==='get_set_mixer')return {stateVersion:1,master:{volume:{value:owner==='master'?own:.9}},
    returns:[{id:'return-0',name:'Reverb',volume:{value:owner==='return-0'?own:.8}},{id:'return-1',name:'Delay',volume:{value:other}}]};
   if(name==='get_return_routing')return {returnTrackId:args.returnTrackId,output:{channel:{id:'1/2'}}};
   if(name==='list_devices')return {trackId:args.trackId,devices:[{id:args.trackId+':device-0',name:'Effect'}]};
   return original(name,args);
  };
  let session=await service.call('start_production_session',{projectId:'song',goal:'Refine this bus',scope:{trackId:owner,deviceId:owner+':device-0'}});
  const observed=artifacts.get('song',session.targetRef).value.observations;
  assert.equal(observed.mixer.volume.value,.8);assert.equal(observed.devices.trackId,owner);
  if(owner==='return-0')assert.equal(observed.routing.returnTrackId,owner);
  const advance=args=>service.call('advance_production_session',{projectId:'song',sessionId:session.sessionId,expectedRevision:session.revision,...args});
  session=await advance({action:'propose'});assert.equal(session.phase,'choose');
  const count=packets.length;other=.2;
  session=await advance({action:'resume'});assert.equal(session.stateChanged,false);assert.equal(session.phase,'choose');
  own=.4;session=await advance({action:'resume'});
  assert.equal(session.stateChanged,true);assert.equal(session.phase,'inspect');assert.equal(session.taskId,undefined);
  assert.equal(packets.length,count);
 }
});

test('durable session routing edits invalidate proposals even at the same state version',async t=>{
 for(const owner of ['track-0','return-0','master']){
  const {service,base}=await setup(t,()=>response({alternatives:[{name:'Keep',description:'Retain the selected path.'}]}));
  let output='1/2';const original=base.call.bind(base);
  base.call=async(name,args)=>{
   if(name==='get_set_mixer')return {master:{outputRouting:{channel:{id:output}}},returns:[{id:'return-0',volume:{value:.8}}]};
   if(name==='get_track_routing'||name==='get_return_routing')return {output:{channel:{id:output}}};
   return original(name,args);
  };
  let session=await service.call('start_production_session',{projectId:'song',goal:'Refine routing',scope:{trackId:owner}});
  session=await service.call('advance_production_session',{projectId:'song',sessionId:session.sessionId,expectedRevision:session.revision,action:'propose'});
  output='3/4';session=await service.call('advance_production_session',{projectId:'song',sessionId:session.sessionId,expectedRevision:session.revision,action:'resume'});
  assert.equal(session.phase,'inspect');assert.equal(session.stateChanged,true);assert.equal(session.taskId,undefined);
 }
});

test('invalid durable owners and bus clip scopes fail before observations or model calls',async t=>{
 for(const scope of [{trackId:'track-00'},{trackId:'return--1'},{trackId:'all'},
  {trackId:'master',clipId:'master:clip-0'},{trackId:'return-0',clipId:'return-0:clip-0'}]){
  const {service,calls,packets}=await setup(t,()=>response());
  await assert.rejects(service.call('start_production_session',{projectId:'song',goal:'Inspect',scope}),/scope|owner|ordinary/);
  assert.equal(calls.length,0);assert.equal(packets.length,0);
 }
});

test('missing or changing bus observations cannot create a durable target',async t=>{
 for(const mode of ['missing','changing']){
  const {service,base}=await setup(t,()=>response());const original=base.call.bind(base);let reads=0;
  base.call=async(name,args)=>name==='get_set_mixer'?{master:{},returns:mode==='missing'?[]:[{id:'return-0',volume:{value:++reads}}]}:original(name,args);
  await assert.rejects(service.call('start_production_session',{projectId:'song',goal:'Inspect',scope:{trackId:'return-0'}}),/Return|changed/);
 }
});

test('discovered shared mixer proposals retain the exact declared owner scope',async t=>{
 for(const [owner,tool,args,allowed] of [
  ['return-0','set_return_mixer',{returnTrackId:'return-0',mute:true},true],
  ['return-0','set_return_mixer',{returnTrackId:'return-1',mute:true},false],
  ['return-0','set_master_mixer',{pan:.2},false],
  ['master','set_master_mixer',{pan:.2},true],
  ['master','set_return_mixer',{returnTrackId:'return-0',mute:true},false],
  ['track-0','set_master_mixer',{pan:.2},false]]){
  const {service,calls}=await setup(t,packet=>packet.progress.turn===1?
   response({reads:[{tool:'discover_production_tools',args:{query:tool,kind:'operation'}}]}):response({operations:[{tool,args}]}));
  const request=service.call('run_production_task',{projectId:'song',goal:'Propose one explicitly scoped mixer change',roles:'functional',scope:{trackId:owner}});
  if(allowed)assert.equal((await request).operationCount,1);else await assert.rejects(request,/scope/);
  assert.equal(calls.some(call=>call.name===tool),false);
 }
});

test('explicit native verification failures stop durable execution despite passing field checks',async t=>{
 for(const completion of ['listening','postconditions']){
 const {service,base,artifacts}=await setup(t,packet=>response(packet.role==='creative'?
  {alternatives:[{name:'Try',description:'Apply one guarded change.'}]}:{operations:[{tool:'set_tempo',args:{tempo:100}}]}));
 const original=base.call.bind(base);
 base.call=async(name,args)=>{
  const result=await original(name,args);
  return name==='set_tempo'&&args.dryRun===false?{...result,observed:{verified:false,writeRequested:true,nativeReturned:true,
   targetRetained:true,contextPreserved:false,error:'unrequested context changed'}}:result;
 };
 let session=await service.call('start_production_session',{projectId:'song',goal:'Apply one guarded change',
  completion,
  postconditions:[{tool:'get_live_state',args:{},path:['tempo'],expected:100}]});
 const advance=args=>service.call('advance_production_session',{projectId:'song',sessionId:session.sessionId,expectedRevision:session.revision,...args});
 for(const args of [{action:'propose'},{action:'choose',alternativeIndex:0},{action:'propose'}])session=await advance(args);
 const plan=await advance({action:'apply',expectedStateVersion:1});
 session=await advance({action:'apply',expectedStateVersion:1,dryRun:false,confirmationToken:plan.operation.confirmationToken,planHash:plan.operation.planHash});
 assert.equal(session.operation.checks[0].matches,true);assert.equal(session.operation.status,'outcome_unknown');
 assert.equal(session.operation.nativeVerificationFailed,true);assert.equal(session.phase,'needs_inspection');
 assert.equal(session.operationIndex,0);
 assert.equal(artifacts.get('song',session.receiptId).value.nativeVerificationFailed,true);
 await assert.rejects(advance({action:'apply',expectedStateVersion:2}),/phase/);
 await assert.rejects(advance({action:'evaluate',decision:'accept'}),/phase/);
 }
});

test('raw and wrapped explicit native failures cannot become applied receipts',async t=>{
 for(const wrapped of [false,true])for(const failure of [{verified:false},{targetRetained:false},{contextPreserved:false},{writeRequested:true,nativeReturned:false},
  {inspectionRequired:true},{writeCompleted:false},{showVerified:false}]){
  const {service,base,artifacts}=await setup(t,()=>response({operations:[{tool:'set_tempo',args:{tempo:100}}]}));
  const original=base.call.bind(base);
  base.call=async(name,args)=>{
   const result=await original(name,args);
   return name==='set_tempo'&&args.dryRun===false?(wrapped?{...result,observed:failure}:{...result,...failure}):result;
  };
  const task=await service.call('run_production_task',{projectId:'song',goal:'Apply one guarded change',roles:'functional'});
  const args={projectId:'song',taskId:task.taskId,operationIndex:0,expectedStateVersion:1};
  const plan=await service.call('apply_production_operation',args);
  const result=await service.call('apply_production_operation',{...args,dryRun:false,confirmationToken:plan.confirmationToken,planHash:plan.planHash});
  assert.equal(result.status,'outcome_unknown');assert.equal(result.nativeVerificationFailed,true);
  const saved=artifacts.get('song',result.resultRef).value;
  assert.deepEqual(wrapped?saved.observed:Object.fromEntries(Object.keys(failure).map(key=>[key,saved[key]])),failure);
 }
});

for (const tool of ["set_live_object_colors", "show_live_object", "capture_session_scene", "duplicate_clip"]) for (const succeeds of [false, true])
  test(`${tool} native receipts control durable advancement: success=${succeeds}`, async t => {
    let turn = 0, version = 1;
    const operation = { tool, args: tool === "set_live_object_colors"
      ? { changes: [{ objectId: "track-0", color: "#ff0000" }], expectedSetFingerprint: "set-a" }
      : tool === "show_live_object" ? { trackId: "track-0", view: "Session", expectedSetFingerprint: "set-a" }
      : tool === "capture_session_scene" ? { afterSceneId: "scene-0", name: "Jam" }
      : { trackId: "track-0", clipId: "track-0:clip-0", destinationClipId: "track-0:clip-1" } };
    const fixture = await setup(t, () => ++turn === 1
      ? response({ reads: [{ tool: "discover_production_tools", args: { query: tool, kind: "operation" } }] })
      : response({ operations: [operation] }));
    const { service, base, artifacts, change } = fixture, original = base.call.bind(base);
    const native = new ToolService({ bridge: { async request(method, args) {
      if (method === "get_live_object_colors") return { stateVersion: version, setFingerprint: "set-a", identityToken: "colors", selection: {},
        objects: args.objectIds.map(objectId => ({ objectId, supported: true, color: "#123456", colorIndex: 7 })) };
      if (method === "get_live_navigation_context") return { stateVersion: version, setFingerprint: "set-a", identityToken: "navigation",
        target: { trackId: "track-0", view: "Session" }, selection: {}, views: {}, controls: {}, deviceViews: [], groupsToReveal: [] };
      if (method === "get_session_scene_capture_context") return { stateVersion: version, identityToken: "capture", afterSceneId: "scene-0" };
      if (method === "get_clip_duplication_source") return { stateVersion: version, trackId: "track-0", copyGuardVersion: 2, identityToken: "copy",
        sourceClipId: "track-0:clip-0", targetClipId: "track-0:clip-1", targetTrackId: "track-0" };
      version++; change();
      if (method === "set_live_object_colors") return { stateVersion: version, writeCompleted: true, identityRetained: succeeds, selectionUnchanged: true,
        objects: args.changes.map(({ objectId, color }) => ({ objectId, requestedColor: color, color, colorIndex: 2, supported: true, exactMatch: true, writeReturned: true })) };
      if (method === "capture_session_scene") return { stateVersion: version, captureRequested: true, nativeReturned: succeeds,
        captureVerified: succeeds, audibleOutputVerified: false, error: succeeds ? null : "retained partial scene" };
      if (method === "duplicate_clip") return { stateVersion: version, trackId: "track-0", sourceTrackId: "track-0", sourceClipId: "track-0:clip-0",
        copiedClipId: "track-0:clip-1", copyRequested: true, nativeReturned: true, targetRetained: true, copyVerified: succeeds,
        error: succeeds ? null : "clip copy readback mismatch" };
      assert.equal(method, "show_live_object");
      return { stateVersion: version, target: args.before.target, showVerified: succeeds,
        targetIdentityRetained: succeeds, selectionVerified: succeeds, viewsVerified: succeeds, deviceViewsVerified: succeeds, controlsUnchanged: true };
    } } });
    base.call = (name, args) => name === tool ? native.call(name, args) : original(name, args);
    let session = await service.call("start_production_session", { projectId: "song", goal: "Edit the exact target", roles: "functional",
      scope: tool === "capture_session_scene" ? {} : { trackId: "track-0" }, completion: "postconditions",
      postconditions: [{ tool: "get_live_state", args: {}, path: ["stateVersion"], expected: 2 }] });
    const advance = args => service.call("advance_production_session", { projectId: "song", sessionId: session.sessionId, expectedRevision: session.revision, ...args });
    session = await advance({ action: "propose" });
    const plan = await advance({ action: "apply", expectedStateVersion: 1 });
    session = await advance({ action: "apply", expectedStateVersion: 1, dryRun: false,
      confirmationToken: plan.operation.confirmationToken, planHash: plan.operation.planHash });
    assert.equal(session.operation.checks[0].matches, true);
    assert.equal(session.operation.status, succeeds ? "applied" : "outcome_unknown");
    const observed = artifacts.get("song", session.operation.resultRef).value.observed;
    assert.equal(observed[{ set_live_object_colors: "writeCompleted", show_live_object: "showVerified",
      capture_session_scene: "captureVerified", duplicate_clip: "copyVerified" }[tool]], succeeds);
    if (succeeds) {
      assert.equal(session.phase, "evaluate");
      assert.equal((await advance({ action: "evaluate", decision: "accept" })).phase, "complete");
    } else {
      assert.equal(session.phase, "needs_inspection");
      assert.equal(session.operationIndex, 0);
      await assert.rejects(advance({ action: "apply", expectedStateVersion: 2 }), /phase/);
      await assert.rejects(advance({ action: "evaluate", decision: "accept" }), /phase/);
    }
  });

test('an outer failure cannot be hidden by a positive observed native receipt',async t=>{
 const {service,base}=await setup(t,()=>response({operations:[{tool:'set_tempo',args:{tempo:100}}]}));
 const original=base.call.bind(base);
 base.call=async(name,args)=>{
  const result=await original(name,args);
  return name==='set_tempo'&&args.dryRun===false?{...result,verified:false,observed:{verified:true}}:result;
 };
 const task=await service.call('run_production_task',{projectId:'song',goal:'Apply one guarded change',roles:'functional'});
 const args={projectId:'song',taskId:task.taskId,operationIndex:0,expectedStateVersion:1};
 const plan=await service.call('apply_production_operation',args);
 const result=await service.call('apply_production_operation',{...args,dryRun:false,confirmationToken:plan.confirmationToken,planHash:plan.planHash});
 assert.equal(result.status,'outcome_unknown');assert.equal(result.nativeVerificationFailed,true);
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
    const result = { stateVersion: (await original("get_live_state")).stateVersion, canUndo };
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
  assert.equal(session.phase, "evaluate");
  assert.equal(session.status, "requires_evaluation");
  assert.equal(session.evaluationRef, undefined);
  session = await advance({ action: "evaluate", decision: "accept" });
  assert.equal(session.phase, "complete");
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
