import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";

function context() {
  const parameters = [
    { id: "parameter-4", name: "Grid", originalName: "Grid", min: 0, max: 15,
      value: 7, displayValue: "1/16", enabled: true, quantized: false, valueItems: [] },
    { id: "parameter-2", name: "Interval", originalName: "Interval", min: 0, max: 7,
      value: 5, displayValue: "1 Bar", enabled: true, quantized: false, valueItems: [] },
    { id: "parameter-5", name: "Block Triplets", originalName: "Block Triplets", min: 0, max: 1,
      value: 0, displayValue: "Off", enabled: true, quantized: true, valueItems: ["Off", "On"] },
    { id: "parameter-17", name: "Repeat", originalName: "Repeat", min: 0, max: 1,
      value: 0, displayValue: "Off", enabled: true, quantized: true, valueItems: ["Off", "On"] }
  ];
  return { stateVersion: 3, trackId: "track-0", deviceId: "track-0:device-0",
    device: { id: "track-0:device-0", className: "BeatRepeat", name: "Beat Repeat", active: true },
    parameters, controls: { Grid: parameters[0], Interval: parameters[1],
      "Block Triplets": parameters[2], Repeat: parameters[3] },
    gridChoices: [{ value: 6, displayValue: "1/8" }, { value: 7, displayValue: "1/16" },
      { value: 8, displayValue: "1/12" }],
    intervalChoices: [{ value: 4, displayValue: "1/2" }, { value: 5, displayValue: "1 Bar" },
      { value: 6, displayValue: "2 Bar" }],
    routing: { stateVersion: 3, input: { type: { name: "Ext. In" } }, monitoring: { name: "off" } },
    transport: { stateVersion: 3, isPlaying: false },
    globalLaunchQuantization: { value: 4, name: "2_bars" } };
}

test("Beat Repeat context exposes native grid display and exact repeat choices", async () => {
  const service = new ToolService({ bridge: { async request(method) {
    assert.equal(method, "get_beat_repeat_performance_context");
    return structuredClone(context());
  } } });
  const reply = await createRouter(service)({ id: 1, method: "tools/call", params: {
    name: "get_beat_repeat_performance_context", arguments: { trackId: "track-0", deviceId: "track-0:device-0" }
  } });
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.structuredContent.controls.Grid.displayValue, "1/16");
  assert.deepEqual(reply.result.structuredContent.controls.Repeat.valueItems, ["Off", "On"]);
  assert.equal(reply.result.structuredContent.routing.input.type.name, "Ext. In");
});

test("guarded Beat Repeat toggle includes complete context and reports the observed parameter", async () => {
  let writes = 0;
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_beat_repeat_performance_context") return structuredClone(context());
    if (method === "set_beat_repeat_enabled") {
      writes++;
      assert.deepEqual(params.before, context());
      assert.equal(params.enabled, true);
      return { stateVersion: 4, enabled: true, repeatParameterMatchesTarget: true };
    }
    throw new Error(`unexpected method ${method}`);
  } } });
  const args = { trackId: "track-0", deviceId: "track-0:device-0", expectedStateVersion: 3, enabled: true };
  const dry = await service.call("set_beat_repeat_enabled", args);
  assert.equal(writes, 0);
  assert.equal(dry.plan.before.controls.Grid.displayValue, "1/16");
  const live = await service.call("set_beat_repeat_enabled", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(writes, 1);
  assert.equal(live.observed.repeatParameterMatchesTarget, true);
});

test("Beat Repeat toggle rejects a disabled or already selected native Repeat control", async () => {
  const observed = context();
  observed.controls.Repeat.enabled = false;
  const service = new ToolService({ bridge: { async request() { return structuredClone(observed); } } });
  await assert.rejects(() => service.call("set_beat_repeat_enabled", {
    trackId: "track-0", deviceId: "track-0:device-0", expectedStateVersion: 3, enabled: true
  }), /native Beat Repeat control/);
});

test("guarded Beat Repeat grid selects one exact native display without guessing raw indices", async () => {
  let writes = 0;
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_beat_repeat_performance_context") return structuredClone(context());
    if (method === "set_beat_repeat_grid") {
      writes++;
      assert.equal(params.gridValue, 8);
      assert.equal(params.gridDisplayValue, "1/12");
      assert.deepEqual(params.before.gridChoices, context().gridChoices);
      return { stateVersion: 4, gridParameterMatchesTarget: true,
        controls: { Grid: { value: 8, displayValue: "1/12" } } };
    }
    throw new Error(`unexpected method ${method}`);
  } } });
  const args = { trackId: "track-0", deviceId: "track-0:device-0",
    expectedStateVersion: 3, gridDisplayValue: "1/12" };
  const dry = await service.call("set_beat_repeat_grid", args);
  assert.equal(dry.plan.gridValue, 8);
  assert.equal(writes, 0);
  const live = await service.call("set_beat_repeat_grid", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(writes, 1);
  assert.equal(live.observed.gridParameterMatchesTarget, true);
});

test("Beat Repeat grid refuses ambiguous native display labels", async () => {
  const observed = context();
  observed.gridChoices.push({ value: 9, displayValue: "1/12" });
  const service = new ToolService({ bridge: { async request() { return structuredClone(observed); } } });
  await assert.rejects(() => service.call("set_beat_repeat_grid", {
    trackId: "track-0", deviceId: "track-0:device-0", expectedStateVersion: 3,
    gridDisplayValue: "1/12"
  }), /exact native Beat Repeat grid choice/);
});

test("guarded Beat Repeat interval selects one exact factory display and reports native equality", async () => {
  let writes = 0;
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_beat_repeat_performance_context") return structuredClone(context());
    if (method === "set_beat_repeat_interval") {
      writes++;
      assert.equal(params.intervalValue, 4);
      assert.equal(params.intervalDisplayValue, "1/2");
      assert.deepEqual(params.before.intervalChoices, context().intervalChoices);
      return { stateVersion: 4, intervalParameterMatchesTarget: true,
        controls: { Interval: { value: 4, displayValue: "1/2" } } };
    }
    throw new Error(`unexpected method ${method}`);
  } } });
  const args = { trackId: "track-0", deviceId: "track-0:device-0",
    expectedStateVersion: 3, intervalDisplayValue: "1/2" };
  const dry = await service.call("set_beat_repeat_interval", args);
  assert.equal(dry.plan.intervalValue, 4);
  assert.equal(writes, 0);
  const live = await service.call("set_beat_repeat_interval", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(writes, 1);
  assert.equal(live.observed.intervalParameterMatchesTarget, true);
});

test("Beat Repeat interval refuses ambiguous native display labels", async () => {
  const observed = context();
  observed.intervalChoices.push({ value: 3, displayValue: "1/2" });
  const service = new ToolService({ bridge: { async request() { return structuredClone(observed); } } });
  await assert.rejects(() => service.call("set_beat_repeat_interval", {
    trackId: "track-0", deviceId: "track-0:device-0", expectedStateVersion: 3,
    intervalDisplayValue: "1/2"
  }), /exact native Beat Repeat interval choice/);
});
