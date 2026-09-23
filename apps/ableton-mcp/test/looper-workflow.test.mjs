import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";

function nativeLooperContext() {
  const parameter = (id, name, choices, value) => ({
    id, name, originalName: name, min: 0, max: choices.length - 1, value,
    displayValue: choices[value], enabled: true, quantized: true, valueItems: choices
  });
  const continuous = (id, name, min, max, value, displayValue) => ({
    id, name, originalName: name, min, max, value, displayValue,
    enabled: true, quantized: false, valueItems: []
  });
  const parameters = [
    parameter("parameter-0", "Device On", ["Off", "On"], 1),
    parameter("parameter-1", "State", ["Stop", "Record", "Play", "Overdub"], 2),
    continuous("parameter-2", "Feedback", 0, 1, 1, "100 %"),
    parameter("parameter-3", "Reverse", ["Off", "On"], 0),
    parameter("parameter-4", "Monitor", ["Always", "Never", "Rec/OVR"], 0),
    continuous("parameter-5", "Speed", -36, 36, 0, "0.00"),
    parameter("parameter-6", "Quantization", ["Global", "None", "1 Bar", "1/8T"], 2),
    parameter("parameter-7", "Song Control", ["None", "Start Song"], 1),
    parameter("parameter-8", "Tempo Control", ["None", "Follow song tempo"], 1)
  ];
  return {
    stateVersion: 4, trackId: "track-0", deviceId: "track-0:device-0",
    device: { id: "track-0:device-0", name: "Looper", className: "Looper",
      classDisplayName: "Looper", type: "audio_effect", active: true,
      canHaveChains: false, canHaveDrumPads: false, sampleSource: null, multiSampleMode: null },
    parameters,
    controls: Object.fromEntries(parameters.filter(p => ["State", "Monitor", "Quantization", "Song Control", "Tempo Control"].includes(p.originalName))
      .map(p => [p.originalName, p])),
    routing: { stateVersion: 4, trackId: "track-0",
      input: { type: { id: "all-ins", name: "All Ins" }, channel: { id: "all-channels", name: "All Channels" },
        availableTypes: [{ id: "all-ins", name: "All Ins" }], availableChannels: [{ id: "all-channels", name: "All Channels" }] },
      output: { type: { id: "main", name: "Main" }, channel: { id: "post-mixer", name: "Post Mixer" },
        availableTypes: [{ id: "main", name: "Main" }], availableChannels: [{ id: "post-mixer", name: "Post Mixer" }] },
      monitoring: { value: 1, name: "auto", choices: [{ value: 0, name: "in" }, { value: 1, name: "auto" }, { value: 2, name: "off" }] } },
    transport: { stateVersion: 4, isPlaying: false, metronome: false,
      countInDuration: { value: 0, name: "none", choices: [{ value: 0, name: "none" }] } },
    globalLaunchQuantization: { value: 4, name: "2_bars", choices: [{ value: 4, name: "2_bars" }] }
  };
}

test("Looper performance context exposes one native snapshot of state, quantization, routing, and transport", async () => {
  const context = nativeLooperContext();
  const service = new ToolService({ bridge: { async request(method) {
    assert.equal(method, "get_looper_performance_context");
    return structuredClone(context);
  } } });
  const reply = await createRouter(service)({ id: 1, method: "tools/call", params: {
    name: "get_looper_performance_context", arguments: { trackId: "track-0", deviceId: "track-0:device-0" }
  } });
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.structuredContent.controls.State.displayValue, "Play");
  assert.equal(reply.result.structuredContent.controls.Quantization.displayValue, "1 Bar");
  assert.equal(reply.result.structuredContent.globalLaunchQuantization.name, "2_bars");
  assert.equal(reply.result.structuredContent.routing.input.type.name, "All Ins");
  assert.equal(reply.result.structuredContent.transport.isPlaying, false);
});

test("guarded Looper Record uses exact native context and reports observed state without promising content rollback", async () => {
  const context = nativeLooperContext();
  let writes = 0;
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_looper_performance_context") return structuredClone(context);
    if (method === "set_looper_state") {
      writes++;
      assert.deepEqual(params.before, context);
      assert.equal(params.targetState, "Record");
      const observed = structuredClone(context);
      observed.stateVersion = 5;
      observed.controls.State.value = 1;
      observed.controls.State.displayValue = "Record";
      observed.targetState = "Record";
      observed.stateParameterMatchesTarget = true;
      return observed;
    }
    throw new Error(`unexpected native method ${method}`);
  } } });
  const args = { trackId: "track-0", deviceId: "track-0:device-0",
    expectedStateVersion: 4, targetState: "Record" };
  const dry = await service.call("set_looper_state", args);
  assert.equal(writes, 0);
  assert.equal(dry.plan.before.routing.input.type.name, "All Ins");
  assert.equal(dry.plan.before.controls.Quantization.displayValue, "1 Bar");
  assert.deepEqual(dry.plan.contentMutationRisk, {
    kind: "recorded_loop_content", targetState: "Record", parameterRollbackRestoresContent: false
  });
  const live = await service.call("set_looper_state", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(writes, 1);
  assert.equal(live.observed.stateParameterMatchesTarget, true);
  assert.equal(live.observed.parameters.find(p => p.id === "parameter-1").value, 1);
  assert.match(live.rollback, /recorded loop content/);
});

test("Looper state planning rejects a choice not exposed by native State", async () => {
  const service = new ToolService({ bridge: { async request() { return nativeLooperContext(); } } });
  await assert.rejects(() => service.call("set_looper_state", {
    trackId: "track-0", deviceId: "track-0:device-0", expectedStateVersion: 4,
    targetState: "Punch"
  }), /native Looper state choice/);
});
