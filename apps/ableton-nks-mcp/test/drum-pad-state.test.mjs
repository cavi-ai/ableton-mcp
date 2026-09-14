import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

test("pad writes bind the exact note and reject empty pads", async () => {
  const deviceId = "track-0:device-0";
  const rack = { id: deviceId, canHaveDrumPads: true, drumPads: [{ note: 36, mute: false, solo: false }] };
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_device_hierarchy") return { stateVersion: 4, trackId: "track-0", device: rack };
    assert.equal(method, "set_drum_pad_state");
    assert.deepEqual(params.beforeDevice, rack);
    return { stateVersion: 5, pad: { note: params.note, ...params.changes } };
  } } });
  const args = { trackId: "track-0", deviceId, expectedStateVersion: 4, note: 36, mute: true };
  const dry = await service.call("set_drum_pad_state", args);
  assert.equal(dry.plan.note, 36);
  const applied = await service.call("set_drum_pad_state", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(applied.observed.pad.mute, true);
  await assert.rejects(() => service.call("set_drum_pad_state", { ...args, note: 37 }), /populated drum pad/);
  await assert.rejects(() => service.call("set_drum_pad_state", { ...args, mute: 1 }), /boolean/);
});
