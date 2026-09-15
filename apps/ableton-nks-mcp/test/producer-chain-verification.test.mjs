import test from "node:test";
import assert from "node:assert/strict";
import { verifyProducerChain } from "../src/producer-chain-knowledge.mjs";
import { ToolService } from "../src/tool-service.mjs";

const device = (id, className, name) => ({ id, className, name, type: "audio_effect", active: true });

test("producer-chain verification distinguishes complete order from misplaced and missing stages", () => {
  const ordered = [
    device("device-0", "Utility", "Utility"),
    device("device-1", "Eq8", "EQ Eight"),
    device("device-2", "GlueCompressor", "Glue Compressor"),
    device("device-3", "Limiter", "Limiter")
  ];
  const complete = verifyProducerChain("mastering", ordered);
  assert.equal(complete.matchesRequiredOrder, true);
  assert.deepEqual(complete.missingRequired, []);
  assert.deepEqual(complete.unexpectedDevices, []);
  assert.equal(complete.optionalOmitted[0].profileId, "saturator");

  const misplaced = verifyProducerChain("mastering", [ordered[0], ordered[2], ordered[1], ordered[3]]);
  assert.equal(misplaced.matchesRequiredOrder, false);
  assert.deepEqual(misplaced.outOfOrder.map(({ profileId }) => profileId), ["glue-compressor", "eq-eight"]);

  const missing = verifyProducerChain("mastering", [ordered[0], ordered[1], device("device-x", "UnknownFx", "Unknown FX")]);
  assert.deepEqual(missing.missingRequired.map(({ profileId }) => profileId), ["glue-compressor", "limiter"]);
  assert.deepEqual(missing.unexpectedDevices.map(({ id }) => id), ["device-x"]);
});

test("inspect_producer_chain verifies exact observed track devices without mutations", async () => {
  const calls = [];
  const observed = { stateVersion: 9, trackId: "main", devices: [
    device("device-0", "Utility", "Utility"),
    device("device-1", "Eq8", "EQ Eight"),
    device("device-2", "GlueCompressor", "Glue Compressor"),
    device("device-3", "Limiter", "Limiter")
  ] };
  const service = new ToolService({ bridge: { async request(method, args) {
    calls.push({ method, args });
    if (method === "list_devices") return observed;
    throw new Error(method);
  } } });
  const result = await service.call("inspect_producer_chain", { target: "mastering", trackId: "main" });
  assert.equal(result.stateVersion, 9);
  assert.equal(result.trackId, "main");
  assert.equal(result.verification.matchesRequiredOrder, true);
  assert.deepEqual(calls, [{ method: "list_devices", args: { trackId: "main" } }]);
  observed.trackId = "track-0";
  await assert.rejects(() => service.call("inspect_producer_chain", { target: "mastering", trackId: "main" }), /does not match/);
});
