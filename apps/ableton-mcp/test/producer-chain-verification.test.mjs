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

test("inspect_producer_bus checks child instruments, grouping, routing and ordered bus effects", async () => {
  const calls = [];
  const tracks = { stateVersion: 7, tracks: [
    { id: "track-0", name: "Bass Bus", type: "group", isGroup: true, groupTrackId: null },
    { id: "track-1", name: "Sub", type: "midi", isGroup: false, groupTrackId: "track-0" },
    { id: "track-2", name: "Body", type: "midi", isGroup: false, groupTrackId: "track-0" },
    { id: "track-3", name: "Texture", type: "midi", isGroup: false, groupTrackId: "track-0" }
  ] };
  const devices = {
    "track-0": [device("bus-0", "Utility", "Utility"), device("bus-1", "Eq8", "EQ Eight"), device("bus-2", "Compressor", "Compressor")],
    "track-1": [device("sub-0", "Operator", "Operator")],
    "track-2": [device("body-0", "Wavetable", "Wavetable")],
    "track-3": [device("texture-0", "Drift", "Drift")]
  };
  const service = new ToolService({ bridge: { async request(method, args) {
    calls.push({ method, args });
    if (method === "list_tracks") return tracks;
    if (method === "list_devices") return { stateVersion: 7, trackId: args.trackId, devices: devices[args.trackId] };
    if (method === "get_track_routing") return { stateVersion: 7, trackId: args.trackId,
      output: { type: { id: args.trackId === "track-3" ? "main" : "track-0", name: "Output" } } };
    throw new Error(method);
  } } });
  const result = await service.call("inspect_producer_bus", { target: "layered-bass-system", busTrackId: "track-0",
    children: [{ role: "sub", trackId: "track-1" }, { role: "body", trackId: "track-2" }, { role: "texture", trackId: "track-3" }] });
  assert.equal(result.busChain.matchesRequiredOrder, true);
  assert.deepEqual(result.children.map(({ role, instrumentMatches, grouped, routed }) =>
    ({ role, instrumentMatches, grouped, routed })), [
    { role: "sub", instrumentMatches: true, grouped: true, routed: true },
    { role: "body", instrumentMatches: true, grouped: true, routed: true },
    { role: "texture", instrumentMatches: true, grouped: true, routed: false }
  ]);
  assert.equal(result.matchesBlueprint, false);
  devices["track-2"] = [{ ...device("body-rack", "InstrumentGroupDevice", "Instrument Rack"),
    chains: [{ id: "body-rack/chain-0", devices: [device("body-rack/chain-0/device-0", "Wavetable", "Wavetable")] }], returnChains: [] }];
  const nested = await service.call("inspect_producer_bus", { target: "layered-bass-system", busTrackId: "track-0",
    children: [{ role: "sub", trackId: "track-1" }, { role: "body", trackId: "track-2" }, { role: "texture", trackId: "track-3" }] });
  assert.equal(nested.children[1].instrumentMatches, true);
  assert.equal(calls.filter(({ method }) => method === "list_tracks").length, 2);
  await assert.rejects(() => service.call("inspect_producer_bus", { target: "mastering", busTrackId: "track-0", children: [] }), /shared-bus/);
  await assert.rejects(() => service.call("inspect_producer_bus", { target: "layered-bass-system", busTrackId: "track-0",
    children: [{ role: "sub", trackId: "track-1" }, { role: "body", trackId: "track-1" }, { role: "texture", trackId: "track-3" }] }), /distinct track/);
});

test("inspect_producer_bus rejects observations from a changed Live state", async () => {
  const service = new ToolService({ bridge: { async request(method, args) {
    if (method === "list_tracks") return { stateVersion: 7, tracks: [{ id: "track-0", isGroup: true }] };
    if (method === "list_devices") return { stateVersion: 8, trackId: args.trackId, devices: [] };
    throw new Error(method);
  } } });
  await assert.rejects(() => service.call("inspect_producer_bus", { target: "layered-bass-system", busTrackId: "track-0",
    children: [{ role: "sub", trackId: "track-1" }, { role: "body", trackId: "track-2" }, { role: "texture", trackId: "track-3" }] }), /state version/);
});

test("inspect_producer_return_bus verifies layered sources, sends-only routing and ordered FX", async () => {
  const tracks = { stateVersion: 12, tracks: [
    { id: "track-0", type: "midi" }, { id: "track-1", type: "midi" }, { id: "track-2", type: "midi" }
  ] };
  const effects = [device("return-0:device-0", "Utility", "Utility"), device("return-0:device-1", "Eq8", "EQ Eight"), device("return-0:device-2", "Compressor", "Compressor")];
  const instruments = { "track-0": [device("device-0", "Operator", "Operator")],
    "track-1": [device("device-0", "Wavetable", "Wavetable")],
    "track-2": [device("device-0", "Drift", "Drift")] };
  const bridge = { async request(method, { trackId } = {}) {
    if (method === "list_tracks") return tracks;
    if (method === "get_set_mixer") return { stateVersion: 12, returns: [{ id: "return-0", name: "A-Bass Bus", devices: effects }] };
    if (method === "list_devices") return { stateVersion: 12, trackId, devices: trackId === "return-0" ? effects : instruments[trackId] };
    if (method === "get_track_mixer") return { stateVersion: 12, trackId, sends: [{ id: "send-0", returnTrackId: "return-0", value: trackId === "track-2" ? 0 : 1 }] };
    if (method === "get_track_routing") return { stateVersion: 12, trackId, output: { type: { id: trackId === "track-2" ? "main" : "sends-only", name: trackId === "track-2" ? "Main" : "Sends Only" } } };
    throw new Error(method);
  } };
  const service = new ToolService({ bridge });
  const result = await service.call("inspect_producer_return_bus", { target: "layered-bass-system", returnTrackId: "return-0",
    children: [{ role: "sub", trackId: "track-0" }, { role: "body", trackId: "track-1" }, { role: "texture", trackId: "track-2" }] });
  assert.equal(result.busChain.matchesRequiredOrder, true);
  assert.deepEqual(result.children.map(child => child.routed), [true, true, false]);
  assert.equal(result.matchesBlueprint, false);
  instruments["track-1"] = [{ ...device("body-rack", "InstrumentGroupDevice", "Instrument Rack"),
    chains: [{ id: "body-rack/chain-0", devices: [device("body-rack/chain-0/device-0", "Wavetable", "Wavetable")] }], returnChains: [] }];
  const nested = await service.call("inspect_producer_return_bus", { target: "layered-bass-system", returnTrackId: "return-0",
    children: [{ role: "sub", trackId: "track-0" }, { role: "body", trackId: "track-1" }, { role: "texture", trackId: "track-2" }] });
  assert.equal(nested.children[1].instrumentMatches, true);
  tracks.stateVersion = 13;
  await assert.rejects(() => service.call("inspect_producer_return_bus", { target: "layered-bass-system", returnTrackId: "return-0",
    children: [{ role: "sub", trackId: "track-0" }, { role: "body", trackId: "track-1" }, { role: "texture", trackId: "track-2" }] }), /state version/);
});

test("inspect_producer_bus verifies audio children without requiring instruments", async () => {
  const tracks = { stateVersion: 11, tracks: [
    { id: "track-0", name: "Vocal Bus", type: "group", isGroup: true, groupTrackId: null },
    { id: "track-1", name: "Lead", type: "audio", isGroup: false, groupTrackId: "track-0" },
    { id: "track-2", name: "Double", type: "audio", isGroup: false, groupTrackId: "track-0" },
    { id: "track-3", name: "Adlibs", type: "audio", isGroup: false, groupTrackId: "track-0" }
  ] };
  const bridge = { async request(method, { trackId } = {}) {
    if (method === "list_tracks") return tracks;
    if (method === "list_devices") return { stateVersion: 11, trackId, devices: trackId === "track-0" ? [
      device("bus-0", "Utility", "Utility"), device("bus-1", "Eq8", "EQ Eight"),
      device("bus-2", "Compressor", "Compressor")
    ] : [] };
    if (method === "get_track_routing") return { stateVersion: 11, trackId,
      output: { type: { id: "track-0", name: "Vocal Bus" } } };
    throw new Error(method);
  } };
  const service = new ToolService({ bridge });
  const args = { target: "layered-vocals-system", busTrackId: "track-0", children: [
    { role: "lead", trackId: "track-1" }, { role: "double", trackId: "track-2" },
    { role: "adlibs", trackId: "track-3" }
  ] };
  const matched = await service.call("inspect_producer_bus", args);
  assert.equal(matched.matchesBlueprint, true);
  assert.deepEqual(matched.children.map(({ sourceMatches }) => sourceMatches), [true, true, true]);
  assert.deepEqual(matched.children.map(({ expectedSourceType, observedSourceType }) =>
    [expectedSourceType, observedSourceType]), [["audio", "audio"], ["audio", "audio"], ["audio", "audio"]]);

  tracks.tracks[2].type = "midi";
  const mismatched = await service.call("inspect_producer_bus", args);
  assert.equal(mismatched.matchesBlueprint, false);
  assert.equal(mismatched.children[1].sourceMatches, false);
});
