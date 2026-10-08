import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isAbsolute } from "node:path";

const audioClipTools = new Set([
  "get_audio_clip_state", "get_audio_source_beat_times", "propose_audio_transient_warp", "analyze_audio_clip"
]);
const anyClipTools = new Set(["get_clip_timing", "get_clip_groove_context", "get_clip_parameter_envelope"]);

// Samples come from ordinary read paths, never from invented fallback IDs.
// Inspect at most eight owners, stopping new reads after five seconds.
export async function discoverExamples(call, batch) {
  const deadline = performance.now() + 5000;
  const read = async (name, args = {}) => {
    if (performance.now() >= deadline) return undefined;
    try { return await call(name, args); } catch { return undefined; }
  };
  const readMany = async requests => {
    if (!requests.length) return [];
    if (performance.now() >= deadline) return requests.map(() => undefined);
    if (batch) {
      try {
        const results = await batch(requests);
        if (Array.isArray(results) && results.length === requests.length) return results;
      } catch { /* Localize a failed read using the bounded sequential fallback. */ }
    }
    const results = [];
    for (const { method, params } of requests) results.push(await read(method, params));
    return results;
  };
  const catalog = await read("search_presets", { limit: 1 });
  const [tracks, browser] = await readMany([{ method: "list_tracks" }, { method: "list_browser_roots" }]);
  const selected = ["midi", "audio"].map(type => tracks?.tracks?.find(track => track.type === type));
  const first = tracks?.tracks?.[0];
  const owners = [...new Map([first, ...selected,
    ...(tracks?.tracks ?? []).filter(track => ["midi", "audio"].includes(track.type))]
    .filter(track => typeof track?.id === "string")
    .map(track => [track.id, track])).values()].slice(0, 8);
  // Framed batches use one connection; the native listener's backlog stays bounded.
  const results = await readMany(owners.flatMap(track => ["list_clips", "list_devices"]
    .map(method => ({ method, params: { trackId: track.id } }))));
  const observed = owners.map((track, index) => {
    const [clips, devices] = results.slice(index * 2, index * 2 + 2);
    const matches = value => value?.trackId === track.id && value.stateVersion === tracks.stateVersion;
    return { track,
      clip: matches(clips) ? clips.clips?.find(clip => clip.hasClip && typeof clip.id === "string") : undefined,
      device: matches(devices) ? devices.devices?.find(device => typeof device.id === "string") : undefined
    };
  });
  const missingTypes = ["midi", "audio"].filter(type => !observed.some(entry => entry.track.type === type && entry.clip));
  const arrangementOwners = observed.filter(entry => missingTypes.includes(entry.track.type));
  const arrangement = await readMany(arrangementOwners.map(entry => ({ method: "list_arrangement_clips",
    params: { trackId: entry.track.id } })));
  for (const [index, entry] of arrangementOwners.entries()) {
    const result = arrangement[index];
    if (result?.trackId === entry.track.id && result.stateVersion === tracks.stateVersion) {
      entry.clip = result.clips?.find(clip => clip.type === entry.track.type && typeof clip.id === "string");
    }
  }
  const clipTarget = type => {
    const entry = observed.find(entry => entry.track.type === type && entry.clip);
    return entry ? { trackId: entry.track.id, clipId: entry.clip.id } : undefined;
  };
  const midiClip = clipTarget("midi"), audioClip = clipTarget("audio");
  const device = observed.find(entry => entry.device);
  let sourcePath;
  if (audioClip) {
    const audio = await read("get_audio_clip_state", audioClip);
    if (audio?.trackId === audioClip.trackId && audio.clipId === audioClip.clipId &&
        audio.stateVersion === tracks.stateVersion && typeof audio.source?.path === "string" && isAbsolute(audio.source.path)) {
      try { if ((await stat(audio.source.path)).isFile()) sourcePath = audio.source.path; } catch { /* Missing source. */ }
    }
  }
  return {
    presetId: catalog?.presets?.[0]?.id,
    trackId: first?.id,
    device: device ? { trackId: device.track.id, deviceId: device.device.id } : undefined,
    midiClip, audioClip, sourcePath,
    root: browser?.roots?.find(root => root.available && typeof root.root === "string")?.root
  };
}

export function withDiscoveryExamples(tools, examples) {
  return tools.map(tool => {
    if (!tool.annotations.readOnlyHint) return tool;
    const properties = tool.inputSchema.properties;
    const values = { trackId: examples.trackId, presetId: examples.presetId,
      root: examples.root, sourcePath: examples.sourcePath };
    if (properties.deviceId && examples.device) Object.assign(values, examples.device);
    if (properties.clipId) {
      const clip = audioClipTools.has(tool.name) ? examples.audioClip :
        anyClipTools.has(tool.name) ? examples.midiClip ?? examples.audioClip : examples.midiClip;
      if (clip) Object.assign(values, clip);
    }
    return { ...tool, inputSchema: { ...tool.inputSchema,
      properties: Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name,
        typeof values[name] === "string" && (!schema.enum || schema.enum.includes(values[name]))
          ? { ...schema, examples: [values[name]] } : schema
      ]))
    } };
  });
}
