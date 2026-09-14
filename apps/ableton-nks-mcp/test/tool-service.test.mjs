import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolService } from "../src/tool-service.mjs";

test("unwarped loop plans preserve seconds and reject incompatible units", async () => {
  const observed = {
    stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0",
    loop: { enabled: true, unit: "seconds", startSeconds: 0.25, endSeconds: 1.75 }
  };
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_clip_timing") return observed;
    if (method === "set_clip_timing") return { ...observed, stateVersion: 5, loop: { ...observed.loop, ...params.changes.loop } };
    throw new Error(method);
  } } });
  const args = { trackId: observed.trackId, clipId: observed.clipId, expectedStateVersion: 4,
    loop: { startSeconds: 0.5, endSeconds: 2 } };
  const dry = await service.call("set_clip_timing", args);
  assert.deepEqual(dry.plan.changes.loop, { startSeconds: 0.5, endSeconds: 2 });
  const applied = await service.call("set_clip_timing", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.deepEqual(applied.observed.loop, { enabled: true, unit: "seconds", startSeconds: 0.5, endSeconds: 2 });
  await assert.rejects(() => service.call("set_clip_timing", { ...args, loop: { startBeats: 1, endSeconds: 2 } }), /unwarped audio/);
  await assert.rejects(() => service.call("set_clip_timing", { ...args, loop: { startSeconds: 2, endSeconds: 1 } }), /greater than/);
  observed.loop = { enabled: true, startBeats: 0, endBeats: 4 };
  await assert.rejects(() => service.call("set_clip_timing", args), /require unwarped audio/);
});

for (const kind of ["chain", "return-chain"]) test(`device-to-${kind} movement signs source and target hierarchies`, async () => {
  const source = { id: "track-0:device-1", chains: [] };
  const destination = { id: `track-1:device-0/${kind}-0`, devices: [] };
  const rack = { id: "track-1:device-0", canHaveChains: true, chains: kind === "chain" ? [destination] : [], returnChains: kind === "return-chain" ? [destination] : [] };
  const service = new ToolService({ bridge: { async request(method, params) {
    if (method === "get_device_hierarchy") return { stateVersion: 4, trackId: params.trackId, device: params.deviceId === source.id ? source : rack };
    if (method === "move_device_to_chain") return { stateVersion: 5, device: { id: `${destination.id}/device-0` } };
    throw new Error(method);
  } } });
  const args = { trackId: "track-0", deviceId: source.id, targetTrackId: "track-1", targetChainId: destination.id, targetPosition: 0, expectedStateVersion: 4 };
  const dry = await service.call("move_device_to_chain", args);
  assert.deepEqual(dry.plan.beforeDevice, source);
  assert.deepEqual(dry.plan.beforeTargetRack, rack);
  assert.match(dry.plan.warning, /macro mappings/);
  assert.match(dry.plan.warning, /does not restore/);
  await assert.rejects(() => service.call("move_device_to_chain", { ...args, targetPosition: 2 }), /insertion index/);
  const result = await service.call("move_device_to_chain", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.device.id, `${destination.id}/device-0`);
});

test("rack chain creation confirms exact hierarchy and validates insertion", async () => {
  const rack = { id: "track-0:device-0", canHaveChains: true, chains: [{ id: "track-0:device-0/chain-0", name: "Existing", devices: [] }] };
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, params) {
    calls.push({ method, params });
    if (method === "get_device_hierarchy") return { stateVersion: 4, trackId: "track-0", device: rack };
    if (method === "create_rack_chain") return { stateVersion: 5, createdChainId: `${rack.id}/chain-1` };
    throw new Error(method);
  } } });
  const args = { trackId: "track-0", deviceId: rack.id, expectedStateVersion: 4, index: 1, name: "Bass layer" };
  const dry = await service.call("create_rack_chain", args);
  assert.deepEqual(dry.plan.beforeDevice, rack);
  await assert.rejects(() => service.call("create_rack_chain", { ...args, index: 3 }), /insertion index/);
  const result = await service.call("create_rack_chain", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.createdChainId, `${rack.id}/chain-1`);
  assert.equal(calls.at(-1).method, "create_rack_chain");
});

function fixture({ extendedNotes = [{ noteId: 7, pitch: 60, start: 0, duration: 1, velocity: 100,
  velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }] } = {}) {
  const calls = [];
  const kompleteCalls = [];
  const bridge = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "get_live_state") return { stateVersion: 4, setFingerprint: "set:a" };
      if (method === "get_history_state") return { stateVersion: 4, canUndo: true, canRedo: false };
      if (method === "undo" || method === "redo") return { stateVersion: 5, canUndo: method === "redo", canRedo: method === "undo" };
      if (method === "get_song_musical_context") return {
        stateVersion: 4,
        timeSignature: { numerator: 4, denominator: 4 },
        key: { rootNote: 0, rootName: "C", scaleName: "Major", scaleMode: true, scaleIntervals: [0, 2, 4, 5, 7, 9, 11] },
        quantization: {
          clipTrigger: { value: 4, name: "1_bar", choices: [{ value: 4, name: "1_bar" }, { value: 7, name: "1_4" }] },
          midiRecording: { value: 5, name: "1_16", choices: [{ value: 0, name: "none" }, { value: 5, name: "1_16" }] }
        },
        groove: { amount: 1, swingAmount: 0, pool: [{ id: "groove-0", name: "Swing 16-65" }] },
        loop: { enabled: false, startBeats: 0, lengthBeats: 8 }
      };
      if (method === "list_tracks") return { stateVersion: 4, tracks: [
        { id: "track-0", name: "Synth", isGroup: false, isGrouped: false, groupTrackId: null, foldState: null },
        { id: "track-1", name: "Empty MIDI", isGroup: true, isGrouped: false, groupTrackId: null, foldState: 0 }
      ] };
      if (method === "list_devices" && params.trackId === "track-1") return {
        stateVersion: 4, trackId: params.trackId, devices: []
      };
      if (method === "get_transport_recording_context") return {
        stateVersion: 4, currentSongTime: 16.5, isPlaying: false, metronome: true,
        arrangement: { record: false, overdub: false, punchIn: true, punchOut: false, backToArranger: false },
        session: { record: false, overdub: true }, automationArm: false
      };
      if (method === "list_arrangement_cue_points") return {
        stateVersion: 4, cuePoints: [{ id: "cue-0", name: "Verse", timeBeats: 16 }]
      };
      if (method === "list_devices") return { stateVersion: 4, trackId: params.trackId, devices: [
        { id: "device-0", name: "Serum 2", className: "PluginDevice", type: "instrument", active: true },
        { id: "track-0:device-1", name: "EQ Eight", className: "Eq8", type: "audio_effect", active: true }
      ] };
      if (method === "list_scenes") return { stateVersion: 4, scenes: [
        { id: "scene-0", name: "Verse" }, { id: "scene-1", name: "Chorus" }
      ] };
      if (method === "get_browser_items" || method === "get_factory_browser_items") return {
        stateVersion: 4, root: params.root, path: params.path || [],
        item: params.path?.length
          ? { name: params.path.at(-1), uri: "query:Drift", loadable: true, folder: false }
          : { name: "Instruments", uri: "query:instruments", loadable: false, folder: true },
        children: [{ name: "Drift", uri: "query:Drift", loadable: true, folder: false }]
      };
      if (method === "search_browser_items") return {
        stateVersion: 4, root: params.root, path: params.path, query: params.query,
        results: [{ path: ["Splice", "Drums", "Snare.wav"], name: "Snare.wav", uri: "query:snare", loadable: true, folder: false }]
      };
      if (method === "load_browser_item" || method === "load_factory_browser_item") return {
        stateVersion: 5, trackId: params.trackId,
        loadedItem: params.item
      };
      if (method === "set_device_active") return { stateVersion: 5, trackId: params.trackId, device: { ...params.beforeDevice, active: params.active } };
      if (method === "delete_device") return { stateVersion: 5, trackId: params.trackId, deletedDevice: params.beforeDevice, devices: [] };
      if (method === "list_clips") return {
        stateVersion: 4,
        trackId: params.trackId,
        clips: params.trackId === "track-1" ? [
          { id: "track-1:clip-0", name: null, hasClip: false },
          { id: "track-1:clip-1", name: null, hasClip: false }
        ] : [
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
      if (method === "get_track_mixer") return {
        stateVersion: 4, trackId: params.trackId,
        volume: { value: 0.75, min: 0, max: 1 },
        pan: { value: 0, min: -1, max: 1 }, mute: false, solo: false,
        sends: [{ id: "send-0", returnTrackId: "return-0", name: "Reverb", value: 0.2, min: 0, max: 1 }]
      };
      if (method === "get_track_routing") return {
        stateVersion: 4, trackId: params.trackId,
        input: {
          type: { id: "all-ins", name: "All Ins" }, channel: { id: "all-channels", name: "All Channels" },
          availableTypes: [{ id: "all-ins", name: "All Ins" }, { id: "no-input", name: "No Input" }],
          availableChannels: [{ id: "all-channels", name: "All Channels" }, { id: "channel-1", name: "Ch. 1" }]
        },
        output: {
          type: { id: "main", name: "Main" }, channel: { id: "post-mixer", name: "Post Mixer" },
          availableTypes: [{ id: "main", name: "Main" }, { id: "no-output", name: "No Output" }, { id: "track-1", name: "Empty MIDI" }],
          availableChannels: [{ id: "post-mixer", name: "Post Mixer" }]
        },
        monitoring: { value: 1, name: "auto", choices: [{ value: 0, name: "in" }, { value: 1, name: "auto" }, { value: 2, name: "off" }] }
      };
      if (method === "set_track_routing") return { stateVersion: 5, trackId: params.trackId, changes: params.changes };
      if (method === "set_group_fold_state") return { stateVersion: 5, track: { id: params.trackId, foldState: params.folded ? 1 : 0 } };
      if (method === "route_tracks_to_bus") return { stateVersion: 5, busTrackId: params.busTrackId, routes: params.routes };
      if (method === "get_set_mixer") return {
        stateVersion: 4,
        master: {
          volume: { value: 0.8, min: 0, max: 1 }, pan: { value: 0, min: -1, max: 1 },
          cueVolume: { value: 0.7, min: 0, max: 1 }, crossfader: { value: 0, min: -1, max: 1 },
          outputRouting: { supported: true, channel: { id: "1/2", name: "1/2" }, availableChannels: [{ id: "1/2", name: "1/2" }, { id: "3/4", name: "3/4" }] }
        },
        returns: [{ id: "return-0", name: "Reverb", volume: { value: 0.6, min: 0, max: 1 }, pan: { value: 0, min: -1, max: 1 }, mute: false, solo: false }]
      };
      if (method === "set_master_mixer" || method === "set_return_mixer") return { stateVersion: 5, method, ...params };
      if (method === "get_device_hierarchy") return {
        stateVersion: 4, trackId: params.trackId, device: {
          id: params.deviceId, name: "Drum Rack", className: "InstrumentGroupDevice",
          classDisplayName: "Drum Rack", type: "instrument", canHaveChains: true,
          canHaveDrumPads: true, chains: [], drumPads: []
        }
      };
      if (method === "set_track_mixer") return {
        stateVersion: 5, trackId: params.trackId, volume: 0, pan: 0, mute: true, solo: false,
        sends: [{ id: "send-0", returnTrackId: "return-0", name: "Reverb", value: 1 }]
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
      if (method === "duplicate_clip" || method === "delete_clip") return {
        stateVersion: 5, trackId: params.trackId, method, clips: []
      };
      if (method === "get_midi_clip_notes") return {
        stateVersion: 4,
        trackId: params.trackId,
        clipId: params.clipId,
        lengthBeats: 4,
        notes: [{ pitch: 60, start: 0, duration: 1, velocity: 100, mute: false }]
      };
      if (method === "get_midi_clip_notes_extended") return {
        stateVersion: 4, trackId: params.trackId, clipId: params.clipId, lengthBeats: 4,
        notes: extendedNotes
      };
      if (method === "set_midi_note_properties") return {
        stateVersion: 5, trackId: params.trackId, clipId: params.clipId, notes: params.changes
      };
      if (["create_track", "create_scene", "rename_session_object"].includes(method)) {
        return { stateVersion: 5, method, ...params };
      }
      if (method === "transform_midi_notes") return {
        stateVersion: 5, trackId: params.trackId, clipId: params.clipId,
        notes: [...(params.changes || []), ...(params.newNotes || [])]
      };
      if (["duplicate_session_object", "delete_session_object"].includes(method)) {
        return { stateVersion: 5, method, ...params };
      }
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
      if (method === "get_clip_timing") return {
        stateVersion: 4, trackId: params.trackId, clipId: params.clipId,
        loop: { enabled: true, startBeats: 0, endBeats: 4 },
        timeSignature: { numerator: 4, denominator: 4 },
        launchQuantization: { value: 0, name: "global", choices: [{ value: 0, name: "global" }, { value: 12, name: "1_16" }] },
        grooveId: null, availableGrooves: [{ id: "groove-0", name: "Swing 16-65" }]
      };
      if (method === "get_audio_clip_state") return {
        stateVersion: 4, trackId: params.trackId, clipId: params.clipId,
        gain: { value: 0.5, min: 0, max: 1, displayValue: "0.00 dB" },
        pitch: { coarse: 0, fine: 0 }, warping: true,
        warpMode: { value: 0, name: "beats", choices: [{ value: 0, name: "beats" }, { value: 6, name: "complex_pro" }] },
        markers: { unit: "beats", startBeats: 0, endBeats: 8 }
      };
      if (method === "set_audio_clip_state") return { stateVersion: 5, trackId: params.trackId, clipId: params.clipId, ...params.changes };
      if (method === "get_transport_context") return {
        stateVersion: 4, isPlaying: false, metronome: false,
        countInDuration: { value: 1, name: "one_bar", choices: [{ value: 0, name: "none" }, { value: 1, name: "one_bar" }, { value: 2, name: "two_bars" }, { value: 3, name: "four_bars" }] }
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
      if (["transport_play", "transport_stop", "set_tempo", "set_transport_context", "set_song_musical_context", "set_transport_recording_context", "create_arrangement_cue_point", "rename_arrangement_cue_point", "delete_arrangement_cue_point", "jump_to_arrangement_cue_point", "set_clip_timing", "duplicate_clip_loop", "set_track_mixer", "launch_scene", "launch_clip", "stop_clip", "arm_track"].includes(method)) {
        return { stateVersion: 5, method, ...params };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
  let metadata = { favorite: false, tags: [], revision: 0 };
  const normalizedTags = (tags) => [...new Set(tags.map((tag) => tag.trim().toLowerCase()))].sort();
  const catalog = {
    search: ({ query, favorite, tags = [] }) => {
      const matches = (favorite === undefined || metadata.favorite === favorite) &&
        normalizedTags(tags).every((tag) => metadata.tags.includes(tag));
      return matches ? [{ id: "serum-2:a", name: query || "Deep", metadata: structuredClone(metadata) }] : [];
    },
    get: (id) => id === "serum-2:a" ? { id, name: "Deep" } : undefined,
    metadata: (id) => {
      if (id !== "serum-2:a") throw new Error(`unknown preset ${id}`);
      return structuredClone(metadata);
    },
    planMetadataUpdate: (id, expectedRevision, changes) => {
      if (id !== "serum-2:a") throw new Error(`unknown preset ${id}`);
      if (expectedRevision !== metadata.revision) throw new Error(`metadata revision mismatch: expected ${expectedRevision}, observed ${metadata.revision}`);
      return { before: structuredClone(metadata), after: {
        favorite: changes.favorite ?? metadata.favorite,
        tags: changes.tags === undefined ? [...metadata.tags] : normalizedTags(changes.tags),
        revision: metadata.revision + 1
      } };
    },
    setMetadata: (id, expectedRevision, changes) => {
      const plan = catalog.planMetadataUpdate(id, expectedRevision, changes);
      metadata = plan.after;
      return structuredClone(metadata);
    },
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

test("preset tags and favorites use exact revisions and confirmed plans", async () => {
  const { service } = fixture();
  assert.deepEqual(await service.call("get_preset_metadata", { presetId: "serum-2:a" }), {
    presetId: "serum-2:a", metadata: { favorite: false, tags: [], revision: 0 }
  });
  const args = {
    presetId: "serum-2:a", expectedMetadataRevision: 0,
    favorite: true, tags: [" Warm ", "bass", "WARM"]
  };
  const dry = await service.call("set_preset_metadata", args);
  assert.deepEqual(dry.plan.after, { favorite: true, tags: ["bass", "warm"], revision: 1 });
  const live = await service.call("set_preset_metadata", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.deepEqual(live.observed, { favorite: true, tags: ["bass", "warm"], revision: 1 });
  assert.equal((await service.call("search_presets", {
    productSlug: "serum-2", favorite: true, tags: ["warm"]
  })).presets.length, 1);
  await assert.rejects(() => service.call("set_preset_metadata", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  }), /metadata revision mismatch/);
});

test("preset metadata rejects stale revisions and empty mutations", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.call("set_preset_metadata", {
    presetId: "serum-2:a", expectedMetadataRevision: 1, favorite: true
  }), /metadata revision mismatch/);
  await assert.rejects(() => service.call("set_preset_metadata", {
    presetId: "serum-2:a", expectedMetadataRevision: 0
  }), /favorite or tags is required/);
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

test("factory browser listing is read-only and exact-path device loading is guarded", async () => {
  const { service, calls } = fixture();
  const listing = await service.call("get_factory_browser_items", { root: "instruments", path: [] });
  assert.equal(listing.children[0].name, "Drift");
  const args = { expectedStateVersion: 4, trackId: "track-0", root: "instruments", path: ["Drift"] };
  const dry = await service.call("load_factory_browser_item", args);
  assert.equal(dry.plan.item.name, "Drift");
  assert.equal(dry.plan.item.loadable, true);
  assert.equal(dry.plan.loadBehavior.mayReplaceExistingDevices, true);
  assert.match(dry.plan.loadBehavior.warning, /replace.*instrument.*rack/i);
  assert.deepEqual(dry.plan.loadBehavior.existingDeviceIds, dry.plan.before.devices.map(({ id }) => id));
  const live = await service.call("load_factory_browser_item", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.loadedItem.name, "Drift");
  assert.deepEqual(calls.slice(-3).map(({ method }) => method), [
    "list_devices", "get_factory_browser_items", "load_factory_browser_item"
  ]);
});

test("Live browser exposes plug-ins and user content through canonical guarded tools", async () => {
  const { service, calls } = fixture();
  const listing = await service.call("get_browser_items", { root: "plugins", path: [] });
  assert.equal(listing.root, "plugins");
  const args = { expectedStateVersion: 4, trackId: "track-0", root: "user_library", path: ["Drift"] };
  const dry = await service.call("load_browser_item", args);
  const live = await service.call("load_browser_item", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.loadedItem.name, "Drift");
  assert.deepEqual(calls.slice(-4).map(({ method }) => method), [
    "get_browser_items", "list_devices", "get_browser_items", "load_browser_item"
  ]);
});

test("Live browser search returns exact loadable paths for user-folder content", async () => {
  const { service } = fixture();
  const result = await service.call("search_browser_items", {
    root: "user_folders", query: " snare ", maxDepth: 4, limit: 25
  });
  assert.deepEqual(result.results[0].path, ["Splice", "Drums", "Snare.wav"]);
  assert.equal(result.query, "snare");
  await assert.rejects(
    () => service.call("search_browser_items", { root: "user_folders", query: "", maxDepth: 4, limit: 25 }),
    /query must be a non-empty string/
  );
});

test("factory browser loading rejects non-loadable and ambiguous requests", async () => {
  const { service } = fixture();
  const base = { expectedStateVersion: 4, trackId: "track-0", root: "instruments" };
  await assert.rejects(() => service.call("load_factory_browser_item", { ...base, path: [] }), /not loadable/);
  await assert.rejects(() => service.call("load_factory_browser_item", { ...base, path: "Drift" }), /path must be an array/);
});

test("scene and clip inspection are exposed as read-only tools and resources", async () => {
  const { service } = fixture();
  assert.equal((await service.call("list_scenes")).scenes[0].name, "Verse");
  assert.equal((await service.call("list_clips", { trackId: "track-0" })).clips[0].name, "Loop");
  assert.equal((await service.readResource("ableton://set/scenes")).scenes[0].name, "Verse");
  assert.equal((await service.readResource("ableton://track/track-0/clips")).clips[0].name, "Loop");
});

test("track and scene creation sign explicit insertion context", async () => {
  const { service } = fixture();
  const track = await service.call("create_track", {
    expectedStateVersion: 4, type: "midi", index: 1, name: "Bass"
  });
  assert.deepEqual(track.plan, {
    method: "create_track", expectedStateVersion: 4, type: "midi", index: 1, name: "Bass",
    before: { count: 2,
      previous: { id: "track-0", name: "Synth", isGroup: false, isGrouped: false, groupTrackId: null, foldState: null },
      next: { id: "track-1", name: "Empty MIDI", isGroup: true, isGrouped: false, groupTrackId: null, foldState: 0 }
    }
  });
  const scene = await service.call("create_scene", {
    expectedStateVersion: 4, index: 0, name: "Intro"
  });
  assert.deepEqual(scene.plan.before, {
    count: 2, previous: null, next: { id: "scene-0", name: "Verse" }
  });
});

test("session object rename resolves the exact current identity", async () => {
  const { service } = fixture();
  const dry = await service.call("rename_session_object", {
    expectedStateVersion: 4, targetType: "clip", trackId: "track-0",
    targetId: "track-0:clip-0", name: "Hook"
  });
  assert.deepEqual(dry.plan.target, {
    targetType: "clip", trackId: "track-0", targetId: "track-0:clip-0",
    previousName: "Loop", name: "Hook"
  });
  await assert.rejects(() => service.call("rename_session_object", {
    expectedStateVersion: 4, targetType: "clip", trackId: "track-0",
    targetId: "track-0:clip-1", name: "Empty"
  }), /empty clip slot/);
});

test("session duplication signs exact source and destination identities", async () => {
  const { service } = fixture();
  const track = await service.call("duplicate_session_object", {
    expectedStateVersion: 4, targetType: "track", targetId: "track-0", name: "Synth Layer"
  });
  assert.deepEqual(track.plan.target, {
    targetType: "track", targetId: "track-0", sourceName: "Synth", name: "Synth Layer", destinationId: "track-1",
    displaced: { id: "track-1", name: "Empty MIDI", isGroup: true, isGrouped: false, groupTrackId: null, foldState: 0 }
  });
  await assert.rejects(() => service.call("duplicate_session_object", {
    expectedStateVersion: 4, targetType: "track", targetId: "track-0", name: "   "
  }), /name must be a non-empty string/);
  const clip = await service.call("duplicate_session_object", {
    expectedStateVersion: 4, targetType: "clip", trackId: "track-0", targetId: "track-0:clip-0"
  });
  assert.deepEqual(clip.plan.target, {
    targetType: "clip", trackId: "track-0", targetId: "track-0:clip-0", name: "Loop",
    destinationId: "track-0:clip-1"
  });
  const scene = await service.call("duplicate_session_object", {
    expectedStateVersion: 4, targetType: "scene", targetId: "scene-0"
  });
  assert.deepEqual(scene.plan.target, {
    targetType: "scene", targetId: "scene-0", name: "Verse", destinationId: "scene-1",
    displaced: { id: "scene-1", name: "Chorus" }
  });
});

test("session deletion requires explicit content authority and records destructive contents", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.call("delete_session_object", {
    expectedStateVersion: 4, targetType: "track", targetId: "track-0"
  }), /allowContent/);
  const track = await service.call("delete_session_object", {
    expectedStateVersion: 4, targetType: "track", targetId: "track-0", allowContent: true
  });
  assert.equal(track.plan.target.clipCount, 1);
  assert.equal(track.plan.target.deviceCount, 2);
  assert.deepEqual(track.plan.target.clips, [{ id: "track-0:clip-0", name: "Loop" }]);
  assert.deepEqual(track.plan.target.devices.map(({ id, name }) => ({ id, name })), [
    { id: "device-0", name: "Serum 2" }, { id: "track-0:device-1", name: "EQ Eight" }
  ]);
  await assert.rejects(() => service.call("delete_session_object", {
    expectedStateVersion: 4, targetType: "scene", targetId: "scene-0"
  }), /allowContent/);
  const scene = await service.call("delete_session_object", {
    expectedStateVersion: 4, targetType: "scene", targetId: "scene-0", allowContent: true
  });
  assert.deepEqual(scene.plan.target.occupiedClips, [
    { trackId: "track-0", clipId: "track-0:clip-0", name: "Loop" }
  ]);
  const clip = await service.call("delete_session_object", {
    expectedStateVersion: 4, targetType: "clip", trackId: "track-0", targetId: "track-0:clip-0"
  });
  assert.equal(clip.plan.target.name, "Loop");
});

test("MIDI note inspection returns exact clip contents without mutation", async () => {
  const { service, calls } = fixture();
  const result = await service.call("get_midi_clip_notes", { trackId: "track-0", clipId: "track-0:clip-0" });
  assert.deepEqual(result.notes[0], { pitch: 60, start: 0, duration: 1, velocity: 100, mute: false });
  assert.equal(calls.at(-1).method, "get_midi_clip_notes");
});

test("extended MIDI note inspection exposes stable IDs and every supported property", async () => {
  const { service } = fixture();
  const result = await service.call("get_midi_clip_notes_extended", { trackId: "track-0", clipId: "track-0:clip-0" });
  assert.deepEqual(result.notes[0], {
    noteId: 7, pitch: 60, start: 0, duration: 1, velocity: 100,
    velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false
  });
});

test("automation capabilities state the exact Live API boundary", async () => {
  const { service, calls } = fixture();
  const result = await service.call("get_automation_capabilities");
  assert.equal(result.sessionClipParameterEnvelopes.write, true);
  assert.equal(result.arrangementParameterAutomation.write, false);
  assert.deepEqual(result.perNoteProperties.fields, [
    "pitch", "start", "duration", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"
  ]);
  assert.deepEqual(calls, []);
});

test("track mixer inspection exposes bounded controls and named return sends", async () => {
  const { service } = fixture();
  const mixer = await service.call("get_track_mixer", { trackId: "track-0" });
  assert.deepEqual(mixer.sends[0], {
    id: "send-0", returnTrackId: "return-0", name: "Reverb", value: 0.2, min: 0, max: 1
  });
});

test("nested rack devices support factory context and guarded activation", async () => {
  const deviceId = "track-0:device-0/chain-0/device-0";
  const device = { id: deviceId, name: "Operator", className: "Operator", classDisplayName: "Operator", active: true };
  const service = new ToolService({ catalog: {}, bridge: { request: async (method, args) => {
    if (method === "get_device_hierarchy") return { stateVersion: 4, trackId: "track-0", device };
    if (method === "list_devices") return { stateVersion: 4, devices: [] };
    if (method === "list_device_parameters") return { stateVersion: 4, parameters: [] };
    if (method === "set_device_active") return { stateVersion: 5, device: { ...device, active: args.active } };
    throw new Error(`unexpected method ${method}`);
  } } });
  const base = { trackId: "track-0", deviceId, expectedStateVersion: 4 };
  const context = await service.call("get_factory_device_context", base);
  assert.equal(context.device.id, deviceId);
  assert.equal(context.profile.id, "operator");
  const dry = await service.call("set_device_active", { ...base, active: false });
  assert.equal(dry.plan.beforeDevice.id, deviceId);
  const applied = await service.call("set_device_active", { ...base, active: false, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(applied.observed.device.active, false);
  const deletion = await service.call("delete_device", base);
  assert.equal(deletion.plan.deviceId, deviceId);
  assert.equal(deletion.plan.beforeDevice.id, deviceId);
});

test("factory device context combines stable identity, knowledge, and live parameters", async () => {
  const { service } = fixture();
  const context = await service.call("get_factory_device_context", {
    trackId: "track-0", deviceId: "track-0:device-1"
  });
  assert.equal(context.device.className, "Eq8");
  assert.equal(context.profile.id, "eq-eight");
  assert.deepEqual(context.parameterGroups.frequency.map(({ id }) => id), ["cutoff"]);
});

test("device activation and deletion use guarded exact-identity plans", async () => {
  const { service, calls } = fixture();
  const base = { expectedStateVersion: 4, trackId: "track-0", deviceId: "track-0:device-1" };
  const activeDry = await service.call("set_device_active", { ...base, active: false });
  assert.equal(activeDry.plan.beforeDevice.name, "EQ Eight");
  assert.equal(activeDry.plan.active, false);
  const active = await service.call("set_device_active", {
    ...base, active: false, dryRun: false,
    confirmationToken: activeDry.confirmation.token, planHash: activeDry.confirmation.planHash
  });
  assert.equal(active.observed.device.active, false);
  const deleteDry = await service.call("delete_device", base);
  assert.equal(deleteDry.plan.beforeDevice.className, "Eq8");
  const deleted = await service.call("delete_device", {
    ...base, dryRun: false,
    confirmationToken: deleteDry.confirmation.token, planHash: deleteDry.confirmation.planHash
  });
  assert.equal(deleted.observed.deletedDevice.name, "EQ Eight");
  assert.deepEqual(calls.slice(-2).map(({ method }) => method), ["list_devices", "delete_device"]);
});

test("device lifecycle rejects unknown identities and invalid activation state", async () => {
  const { service } = fixture();
  const base = { expectedStateVersion: 4, trackId: "track-0" };
  await assert.rejects(() => service.call("delete_device", { ...base, deviceId: "track-0:device-9" }), /unknown device/);
  await assert.rejects(() => service.call("set_device_active", { ...base, deviceId: "track-0:device-1", active: "no" }), /active must be boolean/);
});

test("device hierarchy is exposed read-only for rack and drum-pad traversal", async () => {
  const { service } = fixture();
  const hierarchy = await service.call("get_device_hierarchy", {
    trackId: "track-0", deviceId: "track-0:device-0"
  });
  assert.equal(hierarchy.device.className, "InstrumentGroupDevice");
  assert.deepEqual(hierarchy.device.chains, []);
});

test("musical context inspection exposes timing harmony groove and clip loop state", async () => {
  const { service } = fixture();
  const song = await service.call("get_song_musical_context");
  assert.equal(song.key.rootName, "C");
  assert.deepEqual(song.key.scaleIntervals, [0, 2, 4, 5, 7, 9, 11]);
  assert.equal(song.quantization.clipTrigger.name, "1_bar");
  assert.equal(song.groove.pool[0].id, "groove-0");
  const clip = await service.call("get_clip_timing", { trackId: "track-0", clipId: "track-0:clip-0" });
  assert.deepEqual(clip.loop, { enabled: true, startBeats: 0, endBeats: 4 });
});

test("transport recording context inspection exposes playhead and record modes", async () => {
  const { service } = fixture();
  const context = await service.call("get_transport_recording_context");
  assert.equal(context.currentSongTime, 16.5);
  assert.equal(context.arrangement.punchIn, true);
  assert.equal(context.session.overdub, true);
});

test("transport recording context mutation validates and signs exact changes", async () => {
  const { service, calls } = fixture();
  const args = {
    expectedStateVersion: 4, currentSongTime: 32, metronome: false,
    arrangement: { record: true, overdub: true, punchIn: false, punchOut: true, backToArranger: true },
    session: { record: true, overdub: false }, automationArm: true
  };
  const dry = await service.call("set_transport_recording_context", args);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.changes.arrangement, args.arrangement);
  assert.equal(calls.at(-1).method, "get_transport_recording_context");
  await assert.rejects(() => service.call("set_transport_recording_context", {
    expectedStateVersion: 4, currentSongTime: -1
  }), /currentSongTime/);
});

test("arrangement cue points are inspectable and exact mutations are guarded", async () => {
  const { service, calls } = fixture();
  assert.equal((await service.call("list_arrangement_cue_points")).cuePoints[0].timeBeats, 16);
  for (const [name, args] of [
    ["create_arrangement_cue_point", { timeBeats: 32, name: "Chorus" }],
    ["rename_arrangement_cue_point", { cuePointId: "cue-0", name: "Intro" }],
    ["delete_arrangement_cue_point", { cuePointId: "cue-0" }],
    ["jump_to_arrangement_cue_point", { cuePointId: "cue-0" }]
  ]) {
    const dry = await service.call(name, { expectedStateVersion: 4, ...args });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.plan.method, name);
    assert.equal(calls.at(-1).method, "list_arrangement_cue_points");
  }
  await assert.rejects(() => service.call("rename_arrangement_cue_point", {
    expectedStateVersion: 4, cuePointId: "cue-9", name: "Missing"
  }), /unknown cue point/);
});

test("song musical context mutation validates and signs exact producer changes", async () => {
  const { service, calls } = fixture();
  const args = {
    expectedStateVersion: 4,
    timeSignature: { numerator: 7, denominator: 8 },
    key: { rootNote: 2, scaleName: "Dorian", scaleMode: true },
    quantization: { clipTrigger: "1_4", midiRecording: "none" },
    groove: { amount: 0.75, swingAmount: 0.2 },
    loop: { enabled: true, startBeats: 4, lengthBeats: 12 }
  };
  const dry = await service.call("set_song_musical_context", args);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.plan.changes.quantization, { clipTrigger: 7, midiRecording: 0 });
  assert.deepEqual(dry.plan.changes.timeSignature, args.timeSignature);
  assert.equal(calls.at(-1).method, "get_song_musical_context");
});

test("clip timing mutation rejects invalid loops and signs groove assignment", async () => {
  const { service } = fixture();
  const base = { trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4 };
  await assert.rejects(() => service.call("set_clip_timing", {
    ...base, loop: { startBeats: 4, endBeats: 2 }
  }), /endBeats must be greater/);
  await assert.rejects(() => service.call("set_clip_timing", {
    ...base, grooveId: null
  }), /grooveId must identify/);
  const dry = await service.call("set_clip_timing", {
    ...base, loop: { enabled: true, startBeats: 1, endBeats: 5 },
    timeSignature: { numerator: 3, denominator: 4 },
    launchQuantization: "1_16", grooveId: "groove-0"
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.changes.launchQuantization, 12);
  assert.equal(dry.plan.changes.grooveId, "groove-0");
});

test("clip loop duplication signs exact timing and executes once", async () => {
  const { service, calls } = fixture();
  const args = { expectedStateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0" };
  const dry = await service.call("duplicate_clip_loop", args);
  assert.equal(dry.plan.before.loop.endBeats, 4);
  const live = await service.call("duplicate_clip_loop", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.dryRun, false);
  assert.equal(calls.at(-1).method, "duplicate_clip_loop");
});

test("track mixer mutation signs before-and-after context and clamps values", async () => {
  const { service, calls } = fixture();
  const args = {
    expectedStateVersion: 4, trackId: "track-0", volume: -1, mute: true,
    sends: [{ id: "send-0", value: 2 }]
  };
  const dry = await service.call("set_track_mixer", args);
  assert.deepEqual(dry.plan.changes.volume, { previousValue: 0.75, requestedValue: -1, value: 0 });
  assert.deepEqual(dry.plan.changes.sends[0], {
    id: "send-0", returnTrackId: "return-0", name: "Reverb",
    previousValue: 0.2, requestedValue: 2, value: 1
  });
  const live = await service.call("set_track_mixer", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.sends[0].value, 1);
  assert.equal(calls.at(-1).method, "set_track_mixer");
});

test("track mixer mutation rejects unknown sends and empty changes", async () => {
  const { service } = fixture();
  const base = { expectedStateVersion: 4, trackId: "track-0" };
  await assert.rejects(() => service.call("set_track_mixer", base), /at least one mixer change/);
  await assert.rejects(() => service.call("set_track_mixer", {
    ...base, sends: [{ id: "send-9", value: 0.5 }]
  }), /unknown send send-9/);
});

test("track routing exposes exact choices and guards identifier-based changes", async () => {
  const { service, calls } = fixture();
  const observed = await service.call("get_track_routing", { trackId: "track-0" });
  assert.equal(observed.input.type.id, "all-ins");
  const args = { expectedStateVersion: 4, trackId: "track-0", inputChannelId: "channel-1", outputTypeId: "no-output", monitoring: "off" };
  const dry = await service.call("set_track_routing", args);
  assert.equal(dry.plan.changes.inputChannelId.previous.id, "all-channels");
  assert.equal(dry.plan.changes.outputTypeId.value.id, "no-output");
  assert.equal(dry.plan.changes.monitoring.value.name, "off");
  const live = await service.call("set_track_routing", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(calls.at(-1).method, "set_track_routing");
});

test("track routing rejects unknown choices and empty changes", async () => {
  const { service } = fixture();
  const base = { expectedStateVersion: 4, trackId: "track-0" };
  await assert.rejects(() => service.call("set_track_routing", base), /at least one routing change/);
  await assert.rejects(() => service.call("set_track_routing", { ...base, inputTypeId: "missing" }), /unknown inputTypeId/);
  await assert.rejects(() => service.call("set_track_routing", { ...base, monitoring: "sometimes" }), /unknown monitoring/);
});

test("group fold and bus routing mutations validate exact existing track identities", async () => {
  const { service, calls } = fixture();
  const foldArgs = { expectedStateVersion: 4, trackId: "track-1", folded: true };
  const foldDry = await service.call("set_group_fold_state", foldArgs);
  assert.equal(foldDry.plan.before.foldState, 0);
  assert.equal(foldDry.plan.folded, true);

  const routeArgs = { expectedStateVersion: 4, trackIds: ["track-0"], busTrackId: "track-1" };
  const routeDry = await service.call("route_tracks_to_bus", routeArgs);
  assert.equal(routeDry.plan.routes[0].outputTypeId, "track-1");
  assert.equal(routeDry.plan.routes[0].before.id, "main");
  const live = await service.call("route_tracks_to_bus", { ...routeArgs, dryRun: false, confirmationToken: routeDry.confirmation.token, planHash: routeDry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(calls.at(-1).method, "route_tracks_to_bus");

  await assert.rejects(() => service.call("set_group_fold_state", { expectedStateVersion: 4, trackId: "track-0", folded: true }), /not a group/);
  await assert.rejects(() => service.call("route_tracks_to_bus", { expectedStateVersion: 4, trackIds: ["track-1"], busTrackId: "track-1" }), /cannot route.*itself/);
});

test("device reordering requires exact state and confirmation", async () => {
  const { service, calls } = fixture();
  const original = service.bridge.request.bind(service.bridge);
  service.bridge.request = async (method, params) => method === "move_device"
    ? { stateVersion: 5, actualPosition: params.targetPosition }
    : original(method, params);
  const devices = await service.call("list_devices", { trackId: "track-0" });
  const args = { trackId: "track-0", deviceId: devices.devices[0].id, expectedStateVersion: devices.stateVersion, targetPosition: 0 };
  await assert.rejects(() => service.call("move_device", { ...args, targetPosition: -1 }), /nonnegative/);
  const dry = await service.call("move_device", args);
  assert.equal(dry.plan.targetPosition, 0);
  assert.equal(calls.some(({ method }) => method === "move_device"), false);
  const result = await service.call("move_device", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.actualPosition, 0);
});

test("Arrangement placement guards timeline overlap and exact observations", async () => {
  const { service } = fixture();
  const calls = [];
  let timeline = [];
  service.bridge.request = async (method, params) => {
    calls.push(method);
    if (method === "list_clips") return { stateVersion: 4, trackId: "track-0", clips: [{ id: "track-0:clip-0", hasClip: true, lengthBeats: 4 }] };
    if (method === "list_arrangement_clips") return { stateVersion: 4, trackId: "track-0", clips: timeline };
    if (method === "place_session_clip_in_arrangement") return { stateVersion: 5, placedClip: { startBeats: params.startBeats, endBeats: params.endBeats } };
    throw new Error(`unexpected ${method}`);
  };
  const args = { trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4, startBeats: 8 };
  const dry = await service.call("place_session_clip_in_arrangement", args);
  assert.equal(dry.plan.endBeats, 12);
  assert.equal(calls.includes("place_session_clip_in_arrangement"), false);
  const result = await service.call("place_session_clip_in_arrangement", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.placedClip.startBeats, 8);
  timeline = [{ startBeats: 10, endBeats: 14 }];
  await assert.rejects(() => service.call("place_session_clip_in_arrangement", args), /overlap/);
  await assert.rejects(() => service.call("place_session_clip_in_arrangement", { ...args, expectedStateVersion: 3 }), /state/i);
});

test("Arrangement deletion carries exact identity and requires confirmation", async () => {
  const { service } = fixture();
  const before = { id: "track-0:arrangement-clip-0", name: "A", startBeats: 8, endBeats: 12, lengthBeats: 4, type: "midi" };
  const mutations = [];
  service.bridge.request = async (method, params) => {
    if (method === "list_arrangement_clips") return { stateVersion: 4, trackId: "track-0", clips: [before] };
    if (method === "delete_arrangement_clip") { mutations.push(params); return { stateVersion: 5, deletedClip: params.before, clips: [] }; }
    throw new Error(`unexpected ${method}`);
  };
  const args = { trackId: "track-0", clipId: before.id, expectedStateVersion: 4 };
  const dry = await service.call("delete_arrangement_clip", args);
  assert.deepEqual(dry.plan.before, before);
  assert.equal(mutations.length, 0);
  await assert.rejects(() => service.call("delete_arrangement_clip", { ...args, clipId: "track-0:arrangement-clip-99" }), /unknown/);
  const result = await service.call("delete_arrangement_clip", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.deepEqual(result.observed.deletedClip, before);
  assert.equal(mutations.length, 1);
});

test("Arrangement moves allow self-overlap but reject other timeline material", async () => {
  const { service } = fixture();
  const clip = { id: "track-0:arrangement-clip-0", name: "A", startBeats: 8, endBeats: 12, lengthBeats: 4, type: "midi" };
  let clips = [clip];
  service.bridge.request = async (method, params) => {
    if (method === "list_arrangement_clips") return { stateVersion: 4, trackId: "track-0", clips };
    if (method === "move_arrangement_clip") return { stateVersion: 5, movedClip: { ...clip, startBeats: params.startBeats, endBeats: params.startBeats + 4 } };
    throw new Error(`unexpected ${method}`);
  };
  const args = { trackId: "track-0", clipId: clip.id, expectedStateVersion: 4, startBeats: 10 };
  const dry = await service.call("move_arrangement_clip", args);
  assert.equal(dry.plan.startBeats, 10);
  assert.deepEqual(dry.plan.before, clip);
  const result = await service.call("move_arrangement_clip", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.observed.movedClip.startBeats, 10);
  clips = [clip, { id: "track-0:arrangement-clip-1", startBeats: 13, endBeats: 17 }];
  await assert.rejects(() => service.call("move_arrangement_clip", args), /overlap another/);
});

test("audio import binds the source revision and an exact empty slot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-audio-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "test.wav");
  await writeFile(sourcePath, "test-source");
  const { service } = fixture();
  let occupied = false;
  const imports = [];
  service.bridge.request = async (method, params) => {
    if (method === "list_clips") return { stateVersion: 4, trackId: "track-0", clips: [{ id: "track-0:clip-0", hasClip: occupied }] };
    if (method === "create_audio_clip") { imports.push(params); return { stateVersion: 5, clips: [{ id: params.clipId, hasClip: true }] }; }
    throw new Error(`unexpected ${method}`);
  };
  const args = { trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4, sourcePath };
  await assert.rejects(() => service.call("create_audio_clip", { ...args, sourcePath: "relative.wav" }), /absolute/);
  const dry = await service.call("create_audio_clip", args);
  assert.equal(dry.plan.sourceFile.size, "11");
  assert.equal(imports.length, 0);
  await writeFile(sourcePath, "changed-source-longer");
  await assert.rejects(() => service.call("create_audio_clip", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /plan|hash|confirmation/i);
  const refreshed = await service.call("create_audio_clip", args);
  const result = await service.call("create_audio_clip", { ...args, dryRun: false, confirmationToken: refreshed.confirmation.token, planHash: refreshed.confirmation.planHash });
  assert.equal(result.observed.clips[0].hasClip, true);
  assert.equal(imports.length, 1);
  occupied = true;
  await assert.rejects(() => service.call("create_audio_clip", args), /already contains/);
});

test("confirmation binds the fresh mutation plan even when a caller supplies an old hash", async () => {
  const { service, calls } = fixture();
  const args = { expectedStateVersion: 4, volume: 0.5 };
  const dry = await service.call("set_master_mixer", args);
  await assert.rejects(() => service.call("set_master_mixer", { ...args, volume: 0.9, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /plan hash mismatch/);
  await assert.rejects(() => service.call("set_master_mixer", { ...args, volume: 0.9, dryRun: false, confirmationToken: dry.confirmation.token }), /plan hash mismatch/);
  assert.equal(calls.some(({ method }) => method === "set_master_mixer"), false);
  await service.call("set_master_mixer", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(calls.filter(({ method }) => method === "set_master_mixer").length, 1);
});

test("set mixer exposes master and return buses and guards bounded changes", async () => {
  const { service, calls } = fixture();
  const observed = await service.call("get_set_mixer");
  assert.equal(observed.master.cueVolume.value, 0.7);
  assert.equal(observed.returns[0].name, "Reverb");
  await assert.rejects(() => service.call("set_master_mixer", { expectedStateVersion: 4, outputChannelId: "9/10" }), /unavailable/);
  const masterArgs = { expectedStateVersion: 4, volume: 2, crossfader: -2, outputChannelId: "3/4" };
  const masterDry = await service.call("set_master_mixer", masterArgs);
  assert.equal(masterDry.plan.changes.volume.value, 1);
  assert.equal(masterDry.plan.changes.crossfader.value, -1);
  assert.equal(masterDry.plan.changes.outputChannelId.value.id, "3/4");
  const masterLive = await service.call("set_master_mixer", {
    ...masterArgs, dryRun: false, confirmationToken: masterDry.confirmation.token, planHash: masterDry.confirmation.planHash
  });
  assert.equal(masterLive.observed.stateVersion, 5);
  const returnArgs = { expectedStateVersion: 5, returnTrackId: "return-0", pan: 0.5, mute: true };
  const refreshed = { ...observed, stateVersion: 5 };
  calls.push({ method: "fixture_state_override", params: refreshed });
  const originalRequest = service.bridge.request.bind(service.bridge);
  service.bridge.request = async (method, params) => method === "get_set_mixer" ? refreshed : originalRequest(method, params);
  const returnDry = await service.call("set_return_mixer", returnArgs);
  assert.equal(returnDry.plan.beforeReturn.name, "Reverb");
  assert.equal(returnDry.plan.changes.mute.value, true);
});

test("set mixer rejects unknown returns and empty mutations", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.call("set_master_mixer", { expectedStateVersion: 4 }), /at least one master mixer change/);
  await assert.rejects(() => service.call("set_return_mixer", { expectedStateVersion: 4, returnTrackId: "return-9", mute: true }), /unknown return track/);
});

test("per-note properties use a guarded exact-ID mutation plan", async () => {
  const { service, calls } = fixture();
  const args = {
    expectedStateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0",
    changes: [{ noteId: 7, probability: 0.25, releaseVelocity: 92, velocityDeviation: -12 }]
  };
  const dry = await service.call("set_midi_note_properties", args);
  assert.equal(dry.plan.changes[0].previous.probability, 1);
  assert.equal(dry.plan.changes[0].probability, 0.25);
  const live = await service.call("set_midi_note_properties", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token,
    planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.notes[0].releaseVelocity, 92);
  assert.equal(calls.at(-1).method, "set_midi_note_properties");
});

test("per-note mutation rejects unknown IDs, invalid ranges, and unsupported MPE curves", async () => {
  const { service } = fixture();
  const base = { expectedStateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0" };
  await assert.rejects(() => service.call("set_midi_note_properties", {
    ...base, changes: [{ noteId: 99, probability: 0.5 }]
  }), /unknown noteId/);
  await assert.rejects(() => service.call("set_midi_note_properties", {
    ...base, changes: [{ noteId: 7, probability: 2 }]
  }), /probability/);
  await assert.rejects(() => service.call("set_midi_note_properties", {
    ...base, changes: [{ noteId: 7, pitchBend: 0.5 }]
  }), /unsupported per-note properties: pitchBend/);
});

test("quantization targets absolute note ends independently of starts", async () => {
  for (const [target, wantStart, wantDuration] of [["end", 0.1, 0.65], ["both", 0, 0.75]]) {
    const { service } = fixture({ extendedNotes: [{ noteId: 7, pitch: 60, start: 0.1, duration: 0.6, velocity: 100,
      velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }] });
    const result = await service.call("transform_midi_notes", {
      trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4,
      noteIds: [7], operation: { type: "quantize", gridBeats: 0.25, target }
    });
    assert.equal(result.plan.changes[0].start, wantStart);
    assert.ok(Math.abs(result.plan.changes[0].duration - wantDuration) < 1e-12);
  }
});

test("end quantization rejects collapsed notes and incompatible duration mode", async () => {
  const { service } = fixture({ extendedNotes: [{ noteId: 7, pitch: 60, start: 0.01, duration: 0.01, velocity: 100,
    velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }] });
  const base = { trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4, noteIds: [7] };
  await assert.rejects(() => service.call("transform_midi_notes", { ...base,
    operation: { type: "quantize", gridBeats: 0.25, target: "end" } }), /non-positive duration/);
  await assert.rejects(() => service.call("transform_midi_notes", { ...base,
    operation: { type: "quantize", gridBeats: 0.25, target: "both", quantizeDuration: true } }), /cannot combine/);
});

test("MIDI note transforms sign hand-derived quantize and legato changes", async () => {
  const { service, calls } = fixture({ extendedNotes: [
    { noteId: 7, pitch: 60, start: 0.1, duration: 0.6, velocity: 100,
      velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }
  ] });
  const quantize = await service.call("transform_midi_notes", {
    trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4,
    noteIds: [7], operation: { type: "quantize", gridBeats: 0.25, strength: 0.5, quantizeDuration: true }
  });
  assert.deepEqual(quantize.plan.changes, [{
    noteId: 7,
    previous: { noteId: 7, pitch: 60, start: 0.1, duration: 0.6, velocity: 100,
      velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false },
    start: 0.05, duration: 0.55
  }]);
  assert.equal(calls.at(-1).method, "get_midi_clip_notes_extended");

  const { service: legatoService } = fixture({ extendedNotes: [
    { noteId: 7, pitch: 60, start: 0, duration: 0.25, velocity: 100,
      velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false },
    { noteId: 8, pitch: 64, start: 0, duration: 0.5, velocity: 90,
      velocityDeviation: 3, releaseVelocity: 70, probability: 0.8, mute: false },
    { noteId: 9, pitch: 67, start: 1.5, duration: 0.5, velocity: 80,
      velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false }
  ] });
  const legato = await legatoService.call("transform_midi_notes", {
    trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4,
    noteIds: [7, 8, 9], operation: { type: "legato", gapBeats: 0.1 }
  });
  assert.deepEqual(legato.plan.changes.map(({ noteId, duration }) => ({ noteId, duration })), [
    { noteId: 7, duration: 1.4 }, { noteId: 8, duration: 1.4 }
  ]);
});

test("MIDI duplication retains expression fields and rejects collisions or overflow", async () => {
  const { service } = fixture();
  const dry = await service.call("transform_midi_notes", {
    trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4,
    noteIds: [7], operation: { type: "duplicate", offsetBeats: 2, repeats: 1 }
  });
  assert.deepEqual(dry.plan.newNotes, [{
    sourceNoteId: 7, pitch: 60, start: 2, duration: 1, velocity: 100,
    velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false
  }]);
  await assert.rejects(() => service.call("transform_midi_notes", {
    trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4,
    noteIds: [7], operation: { type: "duplicate", offsetBeats: 4, repeats: 1 }
  }), /beyond clip length/);
  await assert.rejects(() => service.call("transform_midi_notes", {
    trackId: "track-0", clipId: "track-0:clip-0", expectedStateVersion: 4,
    noteIds: [7, 7], operation: { type: "quantize", gridBeats: 0.25 }
  }), /duplicate noteId/);
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

test("warp marker movement signs exact audio state and requires confirmation", async () => {
  const before = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-2", warping: true,
    warpMarkers: { supported: true, markers: [
      { sampleTime: 0, beatTime: 0 }, { sampleTime: 0.6, beatTime: 1.2 },
      { sampleTime: 2, beatTime: 4 }, { sampleTime: 2.01, beatTime: 4.02 }
    ] } };
  const calls = [];
  const service = new ToolService({ bridge: { async request(method, params) {
    calls.push({ method, params });
    if (method === "get_audio_clip_state") return before;
    if (method === "move_audio_warp_marker") return { ...before, stateVersion: 5,
      warpMarkers: { supported: true, markers: before.warpMarkers.markers.map(m =>
        m.beatTime === 1.2 ? { ...m, beatTime: 1 } : m) } };
    throw new Error(method);
  } } });
  const args = { trackId: before.trackId, clipId: before.clipId, expectedStateVersion: 4, beatTime: 1.2, targetBeatTime: 1 };
  const dry = await service.call("move_audio_warp_marker", args);
  assert.deepEqual(dry.plan.before, before);
  assert.equal(calls.some(c => c.method === "move_audio_warp_marker"), false);
  const applied = await service.call("move_audio_warp_marker", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(applied.observed.warpMarkers.markers[1].beatTime, 1);
  for (const changes of [{ beatTime: 3 }, { targetBeatTime: 4 }, { beatTime: 4.02, targetBeatTime: 4.01 }]) {
    await assert.rejects(() => service.call("move_audio_warp_marker", { ...args, ...changes }), /marker|neighbor/);
  }
});

test("audio clip state exposes warp pitch gain and markers with guarded changes", async () => {
  const { service, calls } = fixture();
  const base = { trackId: "track-0", clipId: "track-0:clip-2" };
  const observed = await service.call("get_audio_clip_state", base);
  assert.equal(observed.warpMode.name, "beats");
  const args = { ...base, expectedStateVersion: 4, gain: 2, pitchCoarse: -12, pitchFine: 17, warpMode: "complex_pro", startMarkerBeats: 1, endMarkerBeats: 7 };
  const dry = await service.call("set_audio_clip_state", args);
  assert.equal(dry.plan.changes.gain.value, 1);
  assert.equal(dry.plan.changes.warpMode.value, 6);
  assert.equal(dry.plan.changes.pitchCoarse.value, -12);
  const live = await service.call("set_audio_clip_state", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(calls.at(-1).method, "set_audio_clip_state");
});

test("audio clip mutation rejects invalid pitch markers and empty changes", async () => {
  const { service } = fixture();
  const base = { trackId: "track-0", clipId: "track-0:clip-2", expectedStateVersion: 4 };
  await assert.rejects(() => service.call("set_audio_clip_state", base), /at least one audio clip change/);
  await assert.rejects(() => service.call("set_audio_clip_state", { ...base, pitchFine: 60 }), /pitchFine/);
  await assert.rejects(() => service.call("set_audio_clip_state", { ...base, startMarkerBeats: 7, endMarkerBeats: 2 }), /endMarkerBeats must be greater/);
  await assert.rejects(() => service.call("set_audio_clip_state", { ...base, startMarkerSeconds: 1 }), /marker units/);
  await assert.rejects(() => service.call("set_audio_clip_state", { ...base, warping: false, startMarkerBeats: 1 }), /marker units/);
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
  for (const name of ["transport_play", "transport_stop", "set_tempo", "launch_scene", "launch_clip", "stop_clip", "arm_track"]) {
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

test("transport context exposes and guards metronome and count-in changes", async () => {
  const { service, calls } = fixture();
  const observed = await service.call("get_transport_context");
  assert.equal(observed.countInDuration.name, "one_bar");
  const args = { expectedStateVersion: 4, metronome: true, countInDuration: "two_bars" };
  const dry = await service.call("set_transport_context", args);
  assert.deepEqual(dry.plan.changes, { metronome: { previous: false, value: true }, countInDuration: { previous: 1, value: 2 } });
  const live = await service.call("set_transport_context", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.dryRun, false);
  assert.equal(calls.at(-1).method, "set_transport_context");
});

test("transport context rejects invalid and empty changes", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.call("set_transport_context", { expectedStateVersion: 4 }), /at least one transport context change/);
  await assert.rejects(() => service.call("set_transport_context", { expectedStateVersion: 4, metronome: "yes" }), /metronome must be boolean/);
  await assert.rejects(() => service.call("set_transport_context", { expectedStateVersion: 4, countInDuration: "eight_bars" }), /countInDuration must be one of/);
});

test("undo and redo expose availability and use guarded history plans", async () => {
  const { service, calls } = fixture();
  const history = await service.call("get_history_state");
  assert.deepEqual(history, { stateVersion: 4, canUndo: true, canRedo: false });
  const dry = await service.call("undo", { expectedStateVersion: 4 });
  assert.equal(dry.plan.method, "undo");
  assert.equal(dry.plan.before.canUndo, true);
  const live = await service.call("undo", {
    expectedStateVersion: 4, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.canRedo, true);
  assert.equal(calls.at(-1).method, "undo");
});

test("history mutations reject unavailable actions", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.call("redo", { expectedStateVersion: 4 }), /redo is not available/);
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

test("clip duplication requires an occupied source and empty target", async () => {
  const { service, calls } = fixture();
  const args = { expectedStateVersion: 4, trackId: "track-0", sourceClipId: "track-0:clip-0", targetClipId: "track-0:clip-1" };
  const dry = await service.call("duplicate_clip", args);
  assert.equal(dry.plan.source.name, "Loop");
  assert.equal(dry.plan.target.hasClip, false);
  const live = await service.call("duplicate_clip", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.dryRun, false);
  assert.equal(calls.at(-1).method, "duplicate_clip");
  await assert.rejects(() => service.call("duplicate_clip", { ...args, sourceClipId: "track-0:clip-1" }), /source clip is empty/);
  await assert.rejects(() => service.call("duplicate_clip", { ...args, targetClipId: "track-0:clip-0" }), /target clip must be empty/);
});

test("clip deletion requires an occupied exact clip", async () => {
  const { service, calls } = fixture();
  const args = { expectedStateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0" };
  const dry = await service.call("delete_clip", args);
  assert.equal(dry.plan.before.name, "Loop");
  const live = await service.call("delete_clip", { ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.dryRun, false);
  assert.equal(calls.at(-1).method, "delete_clip");
  await assert.rejects(() => service.call("delete_clip", { ...args, clipId: "track-0:clip-1" }), /clip is empty/);
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
