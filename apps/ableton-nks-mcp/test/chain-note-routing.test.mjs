import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

test("chain assignment preserves unspecified output-note routing", async () => {
  const deviceId = "track-0:device-0", chainId = `${deviceId}/chain-0`;
  const rack = { id: deviceId, canHaveChains: true, canHaveDrumPads: true,
    chains: [{ id: chainId, noteRouting: { inputNote: 36, outputNote: 60 } }] };
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_device_hierarchy") return { stateVersion: 4, trackId: "track-0", device: rack };
    assert.equal(method, "set_rack_chain_note_routing");
    assert.deepEqual(params.beforeDevice, rack);
    assert.deepEqual(params.changes, { inputNote: 40 });
    return { stateVersion: 5, noteRouting: { inputNote: 40, outputNote: 60 } };
  } } });
  const args = { trackId: "track-0", deviceId, chainId, inputNote: 40, expectedStateVersion: 4 };
  const dry = await service.call("set_rack_chain_note_routing", args);
  assert.deepEqual(dry.plan.changes, { inputNote: 40 });
  const applied = await service.call("set_rack_chain_note_routing", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.deepEqual(applied.observed.noteRouting, { inputNote: 40, outputNote: 60 });
  await assert.rejects(() => service.call("set_rack_chain_note_routing", { ...args, outputNote: 128 }), /0 to 127/);
});
