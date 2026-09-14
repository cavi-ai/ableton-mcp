import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

test("rack mixer plans bind native ranges and exact hierarchy", async () => {
  const deviceId = "track-0:device-0", chainId = `${deviceId}/chain-0`;
  const rack = { id: deviceId, canHaveChains: true, chains: [{ id: chainId, mixer: {
    volume: { value: 0.75, min: 0, max: 1, enabled: true },
    pan: { value: 0, min: -1, max: 1, enabled: true }, mute: false, solo: false
  } }] };
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_device_hierarchy") return { stateVersion: 4, trackId: "track-0", device: rack };
    assert.equal(method, "set_rack_chain_mixer");
    assert.deepEqual(params.beforeDevice, rack);
    return { stateVersion: 5, chainId, mixer: { volume: { value: params.changes.volume } } };
  } } });
  const args = { trackId: "track-0", deviceId, chainId, expectedStateVersion: 4, volume: 0.5 };
  const dry = await service.call("set_rack_chain_mixer", args);
  assert.deepEqual(dry.plan.beforeDevice, rack);
  assert.deepEqual(dry.plan.changes, { volume: 0.5 });
  assert.match(dry.plan.undoLimitation, /not solo/);
  const applied = await service.call("set_rack_chain_mixer", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(applied.observed.mixer.volume.value, 0.5);
  await assert.rejects(() => service.call("set_rack_chain_mixer", { ...args, pan: 2 }), /native range/);
  await assert.rejects(() => service.call("set_rack_chain_mixer", { ...args, chainId: `${deviceId}/chain-9` }), /unknown rack chain/);
});
