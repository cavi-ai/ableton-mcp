import { stat } from "node:fs/promises";

const audioClipTools = new Set([
  "get_audio_clip_state", "get_audio_source_beat_times", "propose_audio_transient_warp", "analyze_audio_clip"
]);
const anyClipTools = new Set(["get_clip_timing", "get_clip_groove_context", "get_clip_parameter_envelope"]);

// Samples come from ordinary read paths, never from invented fallback IDs.
// Inspect at most one track of each kind to keep discovery bounded.
export async function discoverExamples(call) {
  const read = async (name, args = {}) => { try { return await call(name, args); } catch { return undefined; } };
  // The native listener has a small connection backlog. Complete each read
  // before opening the next connection instead of dropping valid examples.
  const catalog = await read("search_presets", { limit: 1 });
  const tracks = await read("list_tracks");
  const browser = await read("list_browser_roots");
  const selected = ["midi", "audio"].map(type => tracks?.tracks?.find(track => track.type === type));
  const first = tracks?.tracks?.[0];
  const owners = [...new Map([first, ...selected].filter(track => typeof track?.id === "string")
    .map(track => [track.id, track])).values()];
  const observed = [];
  for (const track of owners) {
    const clips = await read("list_clips", { trackId: track.id });
    const devices = await read("list_devices", { trackId: track.id });
    const matches = value => value?.trackId === track.id && value.stateVersion === tracks.stateVersion;
    observed.push({ track,
      clip: matches(clips) ? clips.clips?.find(clip => clip.hasClip && typeof clip.id === "string") : undefined,
      device: matches(devices) ? devices.devices?.find(device => typeof device.id === "string") : undefined
    });
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
        audio.stateVersion === tracks.stateVersion && typeof audio.source?.path === "string") {
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
