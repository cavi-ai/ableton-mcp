import test from "node:test";
import assert from "node:assert/strict";
import { ToolService } from "../src/tool-service.mjs";

function fixture() {
  const calls = [];
  const kompleteCalls = [];
  const bridge = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "get_live_state") return { stateVersion: 4, setFingerprint: "set:a" };
      if (method === "list_tracks") return { stateVersion: 4, tracks: [{ id: "track-0", name: "Synth" }] };
      if (method === "list_devices") return { stateVersion: 4, trackId: params.trackId, devices: [{ id: "device-0", name: "Serum 2" }] };
      if (method === "list_scenes") return { stateVersion: 4, scenes: [{ id: "scene-0", name: "Verse" }] };
      if (method === "list_clips") return {
        stateVersion: 4,
        trackId: params.trackId,
        clips: [
          { id: "track-0:clip-0", name: "Loop", hasClip: true },
          { id: "track-0:clip-1", name: null, hasClip: false }
        ]
      };
      if (method === "list_device_parameters") return {
        stateVersion: 4,
        trackId: params.trackId,
        deviceId: params.deviceId,
        parameters: [
          {
            id: "cutoff", name: "Cutoff", originalName: "Filter Freq",
            min: 0, max: 1, value: 0.4, displayValue: "400 Hz",
            enabled: true, quantized: false, valueItems: []
          },
          {
            id: "filter-type", name: "Filter Type", originalName: "Filter Type",
            min: 0, max: 2, value: 1, displayValue: "Band-pass",
            enabled: true, quantized: true,
            valueItems: ["Low-pass", "Band-pass", "High-pass"]
          }
        ]
      };
      if (method === "set_device_parameters") return {
        stateVersion: 5,
        trackId: "t1",
        deviceId: "d1",
        observedChanges: params.changes
      };
      if (method === "create_midi_clip") return {
        stateVersion: 5,
        trackId: params.trackId,
        clip: { id: params.clipId, name: params.name, hasClip: true, lengthBeats: params.lengthBeats, noteCount: params.notes.length }
      };
      if (method === "get_midi_clip_notes") return {
        stateVersion: 4,
        trackId: params.trackId,
        clipId: params.clipId,
        lengthBeats: 4,
        notes: [{ pitch: 60, start: 0, duration: 1, velocity: 100, mute: false }]
      };
      if (method === "get_clip_parameter_envelope") return {
        stateVersion: 4,
        trackId: params.trackId,
        clipId: params.clipId,
        deviceId: params.deviceId,
        parameterId: params.parameterId,
        clipLengthBeats: 4,
        parameter: {
          id: params.parameterId, name: "Cutoff", originalName: "Filter Freq",
          min: 0, max: 1, value: 0.4, displayValue: "400 Hz",
          enabled: true, quantized: false, valueItems: []
        },
        exists: true,
        samples: (params.sampleTimes || []).map((time) => ({ time, value: time / 4 }))
      };
      if (method === "set_clip_parameter_envelope") return {
        stateVersion: 5,
        trackId: params.trackId,
        clipId: params.clipId,
        deviceId: params.deviceId,
        parameterId: params.parameterId,
        replaced: true,
        samples: params.points.map(({ time, value }) => ({ time, value }))
      };
      if (["transport_play", "transport_stop", "set_tempo", "set_track_mixer", "launch_scene", "launch_clip", "stop_clip", "arm_track"].includes(method)) {
        return { stateVersion: 5, method, ...params };
      }
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
  const komplete = {
    async request(method, params = {}) {
      kompleteCalls.push({ method, params });
      if (method === "get_status") return { sessionVersion: 7, state: "idle", instrument: null };
      if (method === "verify_nks_preset") return { sessionVersion: 7, verified: true, fileName: params.fileName };
      return { sessionVersion: 8, method, accepted: true };
    }
  };
  return { service: new ToolService({ bridge, catalog, komplete }), calls, kompleteCalls };
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

test("scene and clip inspection are exposed as read-only tools and resources", async () => {
  const { service } = fixture();
  assert.equal((await service.call("list_scenes")).scenes[0].name, "Verse");
  assert.equal((await service.call("list_clips", { trackId: "track-0" })).clips[0].name, "Loop");
  assert.equal((await service.readResource("ableton://set/scenes")).scenes[0].name, "Verse");
  assert.equal((await service.readResource("ableton://track/track-0/clips")).clips[0].name, "Loop");
});

test("MIDI note inspection returns exact clip contents without mutation", async () => {
  const { service, calls } = fixture();
  const result = await service.call("get_midi_clip_notes", { trackId: "track-0", clipId: "track-0:clip-0" });
  assert.deepEqual(result.notes[0], { pitch: 60, start: 0, duration: 1, velocity: 100, mute: false });
  assert.equal(calls.at(-1).method, "get_midi_clip_notes");
});

test("clip parameter envelope inspection is read-only and returns sampled values", async () => {
  const { service, calls } = fixture();
  const result = await service.call("get_clip_parameter_envelope", {
    trackId: "track-0", clipId: "track-0:clip-0",
    deviceId: "track-0:device-0", parameterId: "cutoff", sampleTimes: [0, 2, 4]
  });
  assert.deepEqual(result.samples, [{ time: 0, value: 0 }, { time: 2, value: 0.5 }, { time: 4, value: 1 }]);
  assert.equal(calls.at(-1).method, "get_clip_parameter_envelope");
});

test("clip parameter envelope replacement validates and signs exact steps", async () => {
  const { service, calls } = fixture();
  const args = {
    expectedStateVersion: 4,
    trackId: "track-0", clipId: "track-0:clip-0",
    deviceId: "track-0:device-0", parameterId: "cutoff",
    points: [{ time: 0, duration: 1, value: -1 }, { time: 2, duration: 0.5, value: 0.8 }]
  };
  const dry = await service.call("set_clip_parameter_envelope", args);
  assert.deepEqual(dry.plan.points, [
    { time: 0, duration: 1, requestedValue: -1, value: 0 },
    { time: 2, duration: 0.5, requestedValue: 0.8, value: 0.8 }
  ]);
  const live = await service.call("set_clip_parameter_envelope", {
    ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.replaced, true);
  assert.equal(calls.at(-1).method, "set_clip_parameter_envelope");
});

test("clip parameter envelope replacement rejects invalid steps", async () => {
  const { service } = fixture();
  const base = {
    expectedStateVersion: 4,
    trackId: "track-0", clipId: "track-0:clip-0",
    deviceId: "track-0:device-0", parameterId: "cutoff"
  };
  await assert.rejects(
    () => service.call("set_clip_parameter_envelope", { ...base, points: [{ time: -1, duration: 1, value: 0.5 }] }),
    /time/
  );
  await assert.rejects(
    () => service.call("set_clip_parameter_envelope", { ...base, points: [{ time: 0, duration: 0, value: 0.5 }] }),
    /duration/
  );
});

test("core transport, mixer, scene, and clip operations use guarded mutation plans", async () => {
  const { service, calls } = fixture();
  for (const name of ["transport_play", "transport_stop", "set_tempo", "set_track_mixer", "launch_scene", "launch_clip", "stop_clip", "arm_track"]) {
    const dry = await service.call(name, { expectedStateVersion: 4, value: 0.5 });
    assert.equal(dry.dryRun, true);
    const live = await service.call(name, {
      expectedStateVersion: 4,
      value: 0.5,
      dryRun: false,
      confirmationToken: dry.confirmation.token,
      planHash: dry.confirmation.planHash
    });
    assert.equal(live.dryRun, false);
    assert.equal(calls.at(-1).method, name);
  }
});

test("core mutations reject stale Ableton state before issuing a plan", async () => {
  const { service, calls } = fixture();
  await assert.rejects(
    () => service.call("transport_play", { expectedStateVersion: 3 }),
    /stateVersion mismatch/
  );
  assert.equal(calls.at(-1).method, "get_live_state");
});

test("MIDI clip creation validates and signs an empty-slot plan", async () => {
  const { service, calls } = fixture();
  const args = {
    trackId: "track-0",
    clipId: "track-0:clip-1",
    expectedStateVersion: 4,
    lengthBeats: 4,
    name: "Agent Pattern",
    notes: [{ pitch: 60, start: 0, duration: 1, velocity: 100 }]
  };
  const dry = await service.call("create_midi_clip", args);
  assert.equal(dry.plan.notes[0].mute, false);
  assert.equal(calls.at(-1).method, "list_clips");
  const live = await service.call("create_midi_clip", {
    ...args,
    dryRun: false,
    confirmationToken: dry.confirmation.token,
    planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.clip.noteCount, 1);
  assert.equal(calls.at(-1).method, "create_midi_clip");
});

test("MIDI clip creation refuses occupied slots and invalid notes", async () => {
  const { service } = fixture();
  const base = { trackId: "track-0", expectedStateVersion: 4, lengthBeats: 4 };
  await assert.rejects(
    () => service.call("create_midi_clip", { ...base, clipId: "track-0:clip-0", notes: [] }),
    /already contains a clip/
  );
  await assert.rejects(
    () => service.call("create_midi_clip", {
      ...base,
      clipId: "track-0:clip-1",
      notes: [{ pitch: 128, start: 0, duration: 1, velocity: 100 }]
    }),
    /pitch/
  );
});

test("mutations require an explicit expected state version", async () => {
  const { service, calls } = fixture();
  await assert.rejects(() => service.call("transport_stop", {}), /expectedStateVersion is required/);
  assert.deepEqual(calls, []);
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

test("parameter mutation plan carries signed before-and-after review context", async () => {
  const { service } = fixture();
  const dry = await service.call("set_device_parameters", {
    trackId: "t1",
    deviceId: "d1",
    expectedStateVersion: 4,
    changes: [
      { id: "cutoff", value: 2 },
      { id: "filter-type", value: 2 }
    ]
  });

  assert.deepEqual(dry.plan.changes, [
    {
      id: "cutoff",
      name: "Cutoff",
      originalName: "Filter Freq",
      previousValue: 0.4,
      previousDisplayValue: "400 Hz",
      requestedValue: 2,
      value: 1,
      targetDisplayValue: null
    },
    {
      id: "filter-type",
      name: "Filter Type",
      originalName: "Filter Type",
      previousValue: 1,
      previousDisplayValue: "Band-pass",
      requestedValue: 2,
      value: 2,
      targetDisplayValue: "High-pass"
    }
  ]);
});

test("Komplete status and preset verification are read-only", async () => {
  const { service, kompleteCalls } = fixture();
  assert.equal((await service.call("komplete_get_status")).sessionVersion, 7);
  assert.equal((await service.call("komplete_verify_nks_preset", { fileName: "Bass.nksf" })).verified, true);
  assert.deepEqual(kompleteCalls.map(({ method }) => method), ["get_status", "verify_nks_preset"]);
});

test("Komplete UI actions require current session state and single-use confirmation", async () => {
  const { service, kompleteCalls } = fixture();
  const args = { expectedSessionVersion: 7, productSlug: "serum-2" };
  const dry = await service.call("komplete_open_instrument", args);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.method, "open_instrument");
  assert.equal(kompleteCalls.at(-1).method, "get_status");

  const live = await service.call("komplete_open_instrument", {
    ...args,
    dryRun: false,
    confirmationToken: dry.confirmation.token,
    planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.accepted, true);
  assert.equal(kompleteCalls.at(-1).method, "open_instrument");
  await assert.rejects(
    () => service.call("komplete_open_instrument", {
      ...args,
      dryRun: false,
      confirmationToken: dry.confirmation.token,
      planHash: dry.confirmation.planHash
    }),
    /unknown/
  );
});

test("Komplete UI actions reject stale session state", async () => {
  const { service, kompleteCalls } = fixture();
  await assert.rejects(
    () => service.call("komplete_run_conversion_batch", { expectedSessionVersion: 6, jobs: [] }),
    /sessionVersion mismatch/
  );
  assert.equal(kompleteCalls.at(-1).method, "get_status");
});
