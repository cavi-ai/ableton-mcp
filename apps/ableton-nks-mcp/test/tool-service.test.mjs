import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

function fixture() {
  const calls = [];
  const bridge = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "get_live_state") return { stateVersion: 4, setFingerprint: "set:a" };
      if (method === "list_tracks") return { stateVersion: 4, tracks: [{ id: "track-0", name: "Synth" }] };
      if (method === "list_devices") return { stateVersion: 4, trackId: params.trackId, devices: [{ id: "device-0", name: "Serum 2" }] };
      if (method === "list_device_parameters") return {
        stateVersion: 4,
        trackId: "t1",
        deviceId: "d1",
        parameters: [{ id: "cutoff", min: 0, max: 1, value: 0.4 }]
      };
      if (method === "set_device_parameters") return {
        stateVersion: 5,
        trackId: "t1",
        deviceId: "d1",
        observedChanges: params.changes
      };
      throw new Error(`unexpected method ${method}`);
    }
  };
  const catalog = {
    search: ({ query }) => [{ id: "serum-2:a", name: query || "Deep" }],
    get: (id) => id === "serum-2:a" ? { id, name: "Deep" } : undefined,
    products: () => [{ productSlug: "serum-2", count: 1 }],
    getArtwork: (id) => id === "art:bass" ? {
      id,
      productSlug: "serum-2",
      category: "bass",
      path: "artwork/nks/variants/serum-2/art-bass.png"
    } : undefined,
    artworkForPreset: (id) => id === "serum-2:a" ? { id: "art:bass" } : undefined
  };
  return { service: new ToolService({ bridge, catalog }), calls };
}

test("search_presets remains read-only", async () => {
  const { service, calls } = fixture();
  const result = await service.call("search_presets", { productSlug: "serum-2", query: "Deep" });
  assert.equal(result.presets[0].id, "serum-2:a");
  assert.deepEqual(calls, []);
});

test("MCP resources return live and catalog-backed content", async () => {
  const { service } = fixture();
  assert.equal((await service.readResource("nks://catalog/products")).products[0].count, 1);
  assert.equal((await service.readResource("nks://catalog/presets/serum-2%3Aa")).preset.name, "Deep");
  assert.equal((await service.readResource("ableton://live/status")).stateVersion, 4);
  assert.equal((await service.readResource("ableton://set/tracks")).tracks[0].name, "Synth");
  assert.equal((await service.readResource("ableton://track/track-0/devices")).devices[0].name, "Serum 2");
  const artwork = await service.readResource("nks://catalog/artwork/art%3Abass");
  assert.equal(artwork.artwork.category, "bass");
  assert.equal(JSON.stringify(artwork).includes("base64"), false);
});

test("unknown artwork resources fail clearly", async () => {
  const { service } = fixture();
  await assert.rejects(
    () => service.readResource("nks://catalog/artwork/art%3Amissing"),
    /unknown artwork art:missing/
  );
});

test("preset, track, and device inspection are exposed as read-only tools", async () => {
  const { service, calls } = fixture();
  assert.equal((await service.call("get_preset", { presetId: "serum-2:a" })).preset.name, "Deep");
  assert.equal((await service.call("list_tracks")).tracks[0].name, "Synth");
  assert.equal((await service.call("list_devices", { trackId: "track-0" })).devices[0].name, "Serum 2");
  assert.deepEqual(calls.map((call) => call.method), ["list_tracks", "list_devices"]);
});

test("parameter mutation defaults to dry-run, clamps, confirms once, and returns observed state", async () => {
  const { service, calls } = fixture();
  const args = { trackId: "t1", deviceId: "d1", expectedStateVersion: 4, changes: [{ id: "cutoff", value: 2 }] };
  const dry = await service.call("set_device_parameters", args);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.changes[0].value, 1);
  assert.equal(calls.at(-1).method, "list_device_parameters");
  const live = await service.call("set_device_parameters", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(calls.at(-1).method, "set_device_parameters");
  await assert.rejects(() => service.call("set_device_parameters", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /unknown/);
});
