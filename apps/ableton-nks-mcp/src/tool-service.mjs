import { assertExpectedState } from "./bridge-protocol.mjs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { analyzeAudioFile } from "./audio-analysis.mjs";
import { ConfirmationStore, hashPlan } from "./confirmation-store.mjs";
import { CatalogService } from "./catalog-service.mjs";
import { getFactoryDeviceProfile, groupDeviceParameters, listFactoryDeviceProfiles } from "./factory-device-knowledge.mjs";

function requireExpectedState(args) {
  if (!Number.isInteger(args.expectedStateVersion)) {
    throw new Error("expectedStateVersion is required for mutations");
  }
}

function requireExpectedSession(args) {
  if (!Number.isInteger(args.expectedSessionVersion)) {
    throw new Error("expectedSessionVersion is required for Komplete mutations");
  }
}

function normalizeChoice(value, field, choices) {
  const choice = typeof value === "string"
    ? choices.find((item) => item.name === value)
    : choices.find((item) => item.value === value);
  if (!choice) throw new Error(`${field} must be one of: ${choices.map(({ name }) => name).join(", ")}`);
  return choice.value;
}

function normalizeSignature(value, field) {
  if (value === undefined) return undefined;
  const numerator = Number(value.numerator);
  const denominator = Number(value.denominator);
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 99) throw new Error(`${field}.numerator must be an integer from 1 to 99`);
  if (![1, 2, 4, 8, 16].includes(denominator)) throw new Error(`${field}.denominator must be 1, 2, 4, 8, or 16`);
  return { numerator, denominator };
}

function finiteRange(value, field, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${field} must be from ${min} to ${max}`);
  return number;
}

function sessionName(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("name must be a non-empty string");
  if (value.length > 255) throw new Error("name must be 255 characters or fewer");
  return value.trim();
}

function insertionContext(items, index) {
  return { count: items.length, previous: index > 0 ? items[index - 1] : null, next: items[index] || null };
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function targetDisplayValue(parameter, value) {
  if (!parameter.quantized || !Array.isArray(parameter.valueItems)) return null;
  const index = Math.round(value - parameter.min);
  if (Math.abs(parameter.min + index - value) > Number.EPSILON) return null;
  return parameter.valueItems[index] ?? null;
}

function normalizeMidiNote(note, index, lengthBeats) {
  const pitch = Number(note.pitch);
  const start = Number(note.start);
  const duration = Number(note.duration);
  const velocity = Number(note.velocity);
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw new Error(`notes[${index}].pitch must be an integer from 0 to 127`);
  if (!Number.isFinite(start) || start < 0) throw new Error(`notes[${index}].start must be zero or greater`);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`notes[${index}].duration must be greater than zero`);
  if (start + duration > lengthBeats) throw new Error(`notes[${index}] extends beyond lengthBeats`);
  if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) throw new Error(`notes[${index}].velocity must be an integer from 1 to 127`);
  return { pitch, start, duration, velocity, mute: note.mute === true };
}

function normalizeEnvelopePoint(point, index, clipLengthBeats, parameter) {
  const time = Number(point.time);
  const duration = Number(point.duration);
  const requestedValue = Number(point.value);
  if (!Number.isFinite(time) || time < 0 || time > clipLengthBeats) {
    throw new Error(`points[${index}].time must be within the clip`);
  }
  if (!Number.isFinite(duration) || duration <= 0 || time + duration > clipLengthBeats) {
    throw new Error(`points[${index}].duration must be greater than zero and remain within the clip`);
  }
  if (!Number.isFinite(requestedValue)) throw new Error(`points[${index}].value must be finite`);
  return {
    time,
    duration,
    requestedValue,
    value: Math.max(parameter.min, Math.min(parameter.max, requestedValue))
  };
}

const midiNotePropertyRanges = {
  pitch: [0, 127, true], start: [0, Infinity, false], duration: [Number.MIN_VALUE, Infinity, false],
  velocity: [1, 127, true], velocityDeviation: [-127, 127, true],
  releaseVelocity: [0, 127, true], probability: [0, 1, false]
};

function normalizeMidiNoteChange(change, index, current, clipLengthBeats) {
  const allowed = new Set(["noteId", "pitch", "start", "duration", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"]);
  const unsupported = Object.keys(change).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`unsupported per-note properties: ${unsupported.join(", ")}`);
  const normalized = { noteId: change.noteId, previous: current };
  if (!Number.isInteger(change.noteId)) throw new Error(`changes[${index}].noteId must be an integer`);
  for (const [key, [min, max, integer]] of Object.entries(midiNotePropertyRanges)) {
    if (change[key] === undefined) continue;
    const value = Number(change[key]);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
      throw new Error(`changes[${index}].${key} is outside its supported range`);
    }
    normalized[key] = value;
  }
  if (change.mute !== undefined) {
    if (typeof change.mute !== "boolean") throw new Error(`changes[${index}].mute must be boolean`);
    normalized.mute = change.mute;
  }
  const start = normalized.start ?? current.start;
  const duration = normalized.duration ?? current.duration;
  if (start + duration > clipLengthBeats) throw new Error(`changes[${index}] extends beyond the clip`);
  if (Object.keys(normalized).length === 2) throw new Error(`changes[${index}] has no properties to update`);
  return normalized;
}

function transformMidiNotes(observed, noteIds, operation) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) throw new Error("noteIds must be a non-empty array");
  if (new Set(noteIds).size !== noteIds.length) throw new Error("duplicate noteId in noteIds");
  const byId = new Map(observed.notes.map((note) => [note.noteId, note]));
  const selected = noteIds.map((noteId) => {
    if (!Number.isInteger(noteId)) throw new Error("noteIds must contain integers");
    const note = byId.get(noteId);
    if (!note) throw new Error(`unknown noteId ${noteId}`);
    return note;
  });
  if (!operation || typeof operation.type !== "string") throw new Error("operation.type is required");

  if (operation.type === "quantize") {
    const grid = Number(operation.gridBeats);
    const strength = operation.strength === undefined ? 1 : Number(operation.strength);
    if (!Number.isFinite(grid) || grid <= 0) throw new Error("operation.gridBeats must be greater than zero");
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("operation.strength must be from 0 to 1");
    if (operation.quantizeDuration !== undefined && typeof operation.quantizeDuration !== "boolean") {
      throw new Error("operation.quantizeDuration must be boolean");
    }
    const target = operation.target ?? "start";
    if (!["start", "end", "both"].includes(target)) throw new Error("operation.target must be start, end, or both");
    if (target !== "start" && operation.quantizeDuration === true) throw new Error("end targets cannot combine with quantizeDuration");
    const changes = selected.map((note) => {
      const targetStart = Math.round(note.start / grid) * grid;
      const start = target === "end" ? note.start : note.start + (targetStart - note.start) * strength;
      const change = { noteId: note.noteId, previous: note, start };
      if (target !== "start") {
        const end = note.start + note.duration;
        change.duration = end + (Math.round(end / grid) * grid - end) * strength - start;
        if (change.duration <= 0) throw new Error(`noteId ${note.noteId} quantizes to non-positive duration`);
      } else if (operation.quantizeDuration === true) {
        const targetDuration = Math.max(grid, Math.round(note.duration / grid) * grid);
        change.duration = note.duration + (targetDuration - note.duration) * strength;
      }
      if (change.start + (change.duration ?? note.duration) > observed.lengthBeats) {
        throw new Error(`noteId ${note.noteId} extends beyond clip length`);
      }
      return change;
    });
    return { changes, newNotes: [] };
  }

  if (operation.type === "legato") {
    const gap = operation.gapBeats === undefined ? 0 : Number(operation.gapBeats);
    if (!Number.isFinite(gap) || gap < 0) throw new Error("operation.gapBeats must be zero or greater");
    const onsets = [...new Set(selected.map((note) => note.start))].sort((a, b) => a - b);
    const nextOnset = new Map(onsets.slice(0, -1).map((onset, index) => [onset, onsets[index + 1]]));
    const changes = selected.filter((note) => nextOnset.has(note.start)).map((note) => {
      const duration = nextOnset.get(note.start) - note.start - gap;
      if (duration <= 0) throw new Error("operation.gapBeats leaves no positive note duration");
      return { noteId: note.noteId, previous: note, duration };
    });
    if (changes.length === 0) throw new Error("legato requires notes at two or more distinct onsets");
    return { changes, newNotes: [] };
  }

  if (operation.type === "duplicate") {
    const offset = Number(operation.offsetBeats);
    const repeats = operation.repeats === undefined ? 1 : Number(operation.repeats);
    if (!Number.isFinite(offset) || offset <= 0) throw new Error("operation.offsetBeats must be greater than zero");
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 16) throw new Error("operation.repeats must be an integer from 1 to 16");
    const occupied = new Set(observed.notes.map((note) => `${note.pitch}:${note.start.toFixed(9)}`));
    const newNotes = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const note of selected) {
        const start = note.start + offset * repeat;
        if (start + note.duration > observed.lengthBeats) throw new Error(`noteId ${note.noteId} duplicate extends beyond clip length`);
        const key = `${note.pitch}:${start.toFixed(9)}`;
        if (occupied.has(key)) throw new Error(`duplicate collision for noteId ${note.noteId}`);
        occupied.add(key);
        newNotes.push({ sourceNoteId: note.noteId, pitch: note.pitch, start, duration: note.duration,
          velocity: note.velocity, velocityDeviation: note.velocityDeviation,
          releaseVelocity: note.releaseVelocity, probability: note.probability, mute: note.mute });
      }
    }
    return { changes: [], newNotes };
  }
  throw new Error("operation.type must be quantize, legato, or duplicate");
}

const unavailableKomplete = {
  async request() {
    throw new Error("Komplete automation worker is not configured");
  }
};

const BROWSER_ROOTS = new Set([
  "audio_effects", "clips", "current_project", "drums", "hotswap_target", "instruments",
  "legacy_libraries", "max_for_live", "midi_effects", "packs", "plugins", "samples", "sounds",
  "user_folders", "user_library"
]);

function normalizeBrowserPath(args) {
  if (!BROWSER_ROOTS.has(args.root)) throw new Error(`unknown Live browser root ${args.root}`);
  if (args.path !== undefined && !Array.isArray(args.path)) throw new Error("path must be an array");
  const path = args.path || [];
  if (path.some((part) => typeof part !== "string" || !part.trim())) throw new Error("path entries must be non-empty strings");
  return { root: args.root, path: path.map((part) => part.trim()) };
}

function normalizeBrowserSearch(args) {
  const browserPath = normalizeBrowserPath(args);
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query must be a non-empty string");
  const maxDepth = args.maxDepth ?? 6;
  const limit = args.limit ?? 50;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 16) throw new Error("maxDepth must be an integer from 1 to 16");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer from 1 to 200");
  return { ...browserPath, query: args.query.trim(), maxDepth, limit };
}

export class ToolService {
  constructor({ bridge, catalog, komplete = unavailableKomplete, confirmations = new ConfirmationStore() }) {
    this.bridge = bridge;
    this.catalog = new CatalogService(catalog);
    this.confirmations = confirmations;
    this.komplete = komplete;
  }

  async call(name, args = {}) {
    if (name === "search_presets") {
      return { presets: this.catalog.search(args) };
    }
    if (name === "get_preset") return { preset: this.catalog.get(args.presetId) };
    if (name === "get_preset_metadata") return { presetId: args.presetId, metadata: this.catalog.metadata(args.presetId) };
    if (name === "set_preset_metadata") return this.#setPresetMetadata(args);
    if (name === "get_live_state") return this.bridge.request("get_live_state", {});
    if (name === "get_transport_context") return this.bridge.request("get_transport_context", {});
    if (name === "get_history_state") return this.bridge.request("get_history_state", {});
    if (name === "get_song_musical_context") return this.bridge.request("get_song_musical_context", {});
    if (name === "get_clip_groove_context") return this.bridge.request("get_clip_groove_context", args);
    if (name === "get_transport_recording_context") return this.bridge.request("get_transport_recording_context", {});
    if (name === "list_arrangement_cue_points") return this.bridge.request("list_arrangement_cue_points", {});
    if (name === "list_tracks") return this.bridge.request("list_tracks", {});
    if (name === "list_scenes") return this.bridge.request("list_scenes", {});
    if (name === "list_clips") return this.bridge.request("list_clips", args);
    if (name === "list_arrangement_clips") return this.bridge.request(name, args);
    if (name === "place_session_clip_in_arrangement") return this.#placeSessionClipInArrangement(args);
    if (name === "delete_arrangement_clip" || name === "move_arrangement_clip") return this.#mutateArrangementClip(name, args);
    if (name === "get_midi_clip_notes") return this.bridge.request("get_midi_clip_notes", args);
    if (name === "get_midi_clip_notes_extended") return this.bridge.request("get_midi_clip_notes_extended", args);
    if (name === "get_track_mixer") return this.bridge.request("get_track_mixer", args);
    if (name === "get_track_routing") return this.bridge.request("get_track_routing", args);
    if (name === "get_set_mixer") return this.bridge.request("get_set_mixer", {});
    if (name === "list_factory_device_profiles") return { profiles: listFactoryDeviceProfiles() };
    if (name === "get_browser_items" || name === "get_factory_browser_items") {
      return this.bridge.request(name, normalizeBrowserPath(args));
    }
    if (name === "search_browser_items") return this.bridge.request(name, normalizeBrowserSearch(args));
    if (name === "get_factory_device_context") {
      const { device } = await this.#observeDevice(args);
      const profile = getFactoryDeviceProfile(device);
      const observed = await this.bridge.request("list_device_parameters", args);
      return {
        stateVersion: observed.stateVersion, trackId: args.trackId, device,
        profile: profile || null,
        parameterGroups: groupDeviceParameters(profile, observed.parameters)
      };
    }
    if (name === "get_automation_capabilities") return {
      sessionClipParameterEnvelopes: { read: true, write: true, shape: "steps" },
      arrangementParameterAutomation: {
        read: false, write: false,
        reason: "Ableton Live's public Clip API returns no automation envelope for Arrangement clips"
      },
      perNoteProperties: {
        read: true, write: true,
        fields: ["pitch", "start", "duration", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute"]
      },
      perNoteExpressionCurves: {
        read: false, write: false,
        reason: "Ableton Live 12.4.5 does not expose pitch-bend, pressure, or slide curves on Live.Clip.MidiNote"
      }
    };
    if (name === "get_clip_parameter_envelope") return this.bridge.request("get_clip_parameter_envelope", args);
    if (name === "get_clip_timing") return this.bridge.request("get_clip_timing", args);
    if (name === "get_audio_clip_state") return this.bridge.request("get_audio_clip_state", args);
    if (name === "get_device_sidechain_routing") return this.bridge.request("get_device_sidechain_routing", args);
    if (name === "analyze_audio_file") return analyzeAudioFile(args.sourcePath, args);
    if (name === "analyze_audio_clip") {
      const target = { trackId: args.trackId, clipId: args.clipId };
      const before = await this.bridge.request("get_audio_clip_state", target);
      if (before.trackId !== target.trackId || before.clipId !== target.clipId) throw new Error("audio clip identity mismatch");
      if (typeof before.source?.path !== "string" || !before.source.path) throw new Error("clip source file is unavailable; update the bridge or locate the missing sample");
      const measurement = await analyzeAudioFile(before.source.path, args);
      const after = await this.bridge.request("get_audio_clip_state", target);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("audio clip changed during analysis; retry against current state");
      return { ...target, stateVersion: after.stateVersion, measurement,
        limitation: "Source audio only; excludes clip gain, transposition, warp, envelopes, and device processing." };
    }
    if (name === "list_devices") return this.bridge.request("list_devices", args);
    if (name === "get_device_hierarchy") return this.bridge.request("get_device_hierarchy", args);
    if (name === "move_device_to_chain") {
      requireExpectedState(args);
      const match = typeof args.targetChainId === "string" && /^(.*)\/(?:return-)?chain-(\d+)$/.exec(args.targetChainId);
      if (!match) throw new Error("invalid target chain ID");
      if (args.targetChainId.startsWith(`${args.deviceId}/`)) throw new Error("cannot move a rack into its own descendant");
      const source = await this.bridge.request("get_device_hierarchy", { trackId: args.trackId, deviceId: args.deviceId });
      assertExpectedState({ expectedStateVersion: args.expectedStateVersion, trackId: args.trackId }, source);
      if (source.device?.id !== args.deviceId) throw new Error("source device identity mismatch");
      const target = await this.bridge.request("get_device_hierarchy", { trackId: args.targetTrackId, deviceId: match[1] });
      assertExpectedState({ expectedStateVersion: args.expectedStateVersion, trackId: args.targetTrackId }, target);
      if (target.device?.id !== match[1] || !target.device.canHaveChains) throw new Error("target rack identity mismatch");
      const chain = [...target.device.chains, ...(target.device.returnChains ?? [])].find((item) => item.id === args.targetChainId);
      if (!chain) throw new Error("unknown target chain");
      if (!Number.isSafeInteger(args.targetPosition) || args.targetPosition < 0 || args.targetPosition > chain.devices.length) throw new Error("invalid target chain insertion index");
      return this.#confirmedMutation({ method: name, trackId: args.trackId, deviceId: args.deviceId,
        targetTrackId: args.targetTrackId, targetChainId: args.targetChainId, targetPosition: args.targetPosition,
        warning: "Moving devices between rack chains may remove macro mappings. Moving the device back does not restore those mappings. Save a rack preset before moving mapped devices; reload that preset for full recall. Inspect parameter enabled states and macro behavior after movement.",
        expectedStateVersion: args.expectedStateVersion, beforeDevice: source.device, beforeTargetRack: target.device }, args);
    }
    if (name === "set_drum_pad_state") {
      requireExpectedState(args);
      const observed = await this.bridge.request("get_device_hierarchy", { trackId: args.trackId, deviceId: args.deviceId });
      assertExpectedState(args, { ...observed, deviceId: observed.device?.id });
      const rack = observed.device;
      if (rack?.id !== args.deviceId || !rack.canHaveDrumPads) throw new Error("device has no drum pads");
      if (!Number.isInteger(args.note) || args.note < 0 || args.note > 127) throw new Error("pad note must be an integer from 0 to 127");
      if (!rack.drumPads.some(pad => pad.note === args.note)) throw new Error("unknown populated drum pad");
      const changes = {};
      for (const key of ["mute", "solo"]) {
        if (args[key] === undefined) continue;
        if (typeof args[key] !== "boolean") throw new Error(`${key} must be boolean`);
        changes[key] = args[key];
      }
      if (!Object.keys(changes).length) throw new Error("no drum pad changes requested");
      if (changes.mute === true && changes.solo === true) throw new Error("a drum pad cannot be requested muted and soloed simultaneously");
      return this.#confirmedMutation({ method: name, trackId: args.trackId, deviceId: args.deviceId,
        note: args.note, expectedStateVersion: args.expectedStateVersion, beforeDevice: rack, changes,
        undoLimitation: "Do not rely on Live undo for pad solo; restore the observed pad state explicitly when needed." }, args);
    }
    if (name === "set_rack_chain_mixer" || name === "rename_rack_chain" || name === "set_rack_chain_note_routing") {
      requireExpectedState(args);
      const observed = await this.bridge.request("get_device_hierarchy", { trackId: args.trackId, deviceId: args.deviceId });
      assertExpectedState(args, { ...observed, deviceId: observed.device?.id });
      const rack = observed.device;
      if (rack?.id !== args.deviceId || !rack.canHaveChains) throw new Error("target rack identity mismatch");
      const availableChains = name === "set_rack_chain_note_routing"
        ? rack.chains : [...rack.chains, ...(rack.returnChains ?? [])];
      const chain = availableChains.find(item => item.id === args.chainId);
      if (!chain) throw new Error("unknown rack chain");
      if (name === "set_rack_chain_note_routing") {
        if (!rack.canHaveDrumPads) throw new Error("note routing requires a Drum Rack");
        const changes = {};
        for (const key of ["inputNote", "outputNote"]) {
          if (args[key] === undefined) continue;
          if (!Number.isInteger(args[key]) || args[key] < 0 || args[key] > 127 || !Number.isInteger(chain.noteRouting?.[key])) throw new Error("chain note routing requires available MIDI notes from 0 to 127");
          changes[key] = args[key];
        }
        if (!Object.keys(changes).length) throw new Error("no chain note routing changes requested");
        return this.#confirmedMutation({ method: name, trackId: args.trackId, deviceId: args.deviceId,
          chainId: args.chainId, expectedStateVersion: args.expectedStateVersion, beforeDevice: rack, changes,
          warning: "Reassigning onto an occupied pad layers chains; it does not replace or delete the destination sound." }, args);
      }
      if (name === "rename_rack_chain") {
        if (typeof args.name !== "string" || !args.name.trim()) throw new Error("chain name must not be empty");
        const isReturn = (rack.returnChains ?? []).some(item => item.id === args.chainId);
        return this.#confirmedMutation({ method: name, trackId: args.trackId, deviceId: args.deviceId,
          chainId: args.chainId, expectedStateVersion: args.expectedStateVersion, beforeDevice: rack, name: args.name,
          ...(isReturn ? { nameBehavior: "raw-return-label",
            warning: "Live adds the return letter prefix to the requested raw label. Read the observed name; do not restore a prefixed display name verbatim, or its prefix will be duplicated. Requested text is never stripped automatically." } : {}) }, args);
      }
      const changes = {};
      for (const key of ["volume", "pan", "mute", "solo"]) {
        if (args[key] === undefined) continue;
        const native = chain.mixer?.[key];
        if (key === "mute" || key === "solo") {
          if (typeof args[key] !== "boolean" || typeof native !== "boolean") throw new Error(`${key} is not writable`);
        } else if (!Number.isFinite(args[key]) || !native?.enabled || args[key] < native.min || args[key] > native.max) throw new Error(`${key} is outside the writable native range`);
        changes[key] = args[key];
      }
      if (args.sends !== undefined) {
        if (!Array.isArray(args.sends) || !args.sends.length) throw new Error("send changes must be a nonempty array");
        const seen = new Set();
        changes.sends = args.sends.map(change => {
          if (!change || typeof change !== "object" || Object.keys(change).sort().join(",") !== "index,value") throw new Error("invalid send change");
          const native = chain.mixer?.sends?.find(send => send.index === change.index);
          if (!Number.isSafeInteger(change.index) || change.index < 0 || seen.has(change.index) || !native) throw new Error("unknown or duplicate send index");
          seen.add(change.index);
          if (!native.enabled || !Number.isFinite(change.value) || change.value < native.min || change.value > native.max) throw new Error("send is outside the writable native range");
          return { index: change.index, value: change.value };
        });
      }
      if (!Object.keys(changes).length) throw new Error("no chain mixer changes requested");
      return this.#confirmedMutation({ method: name, trackId: args.trackId, deviceId: args.deviceId,
        chainId: args.chainId, expectedStateVersion: args.expectedStateVersion, beforeDevice: rack, changes,
        undoLimitation: "Live undo restores chain volume, pan, and mute, but not solo. Restore solo explicitly from beforeDevice when needed.",
        ...(changes.sends ? { warning: "Send indices follow native rack-return order. Return-to-return sends may create feedback; inspect the full return routing before confirming. Restore observed send values explicitly when needed." } : {}) }, args);
    }
    if (name === "create_rack_chain") {
      requireExpectedState(args);
      const observed = await this.bridge.request("get_device_hierarchy", { trackId: args.trackId, deviceId: args.deviceId });
      assertExpectedState(args, { ...observed, deviceId: observed.device?.id });
      const rack = observed.device;
      if (rack?.id !== args.deviceId || !rack.canHaveChains || !Array.isArray(rack.chains)) throw new Error("device does not support rack chain creation");
      const index = args.index === undefined ? rack.chains.length : args.index;
      if (!Number.isInteger(index) || index < 0 || index > rack.chains.length) throw new Error("invalid rack chain insertion index");
      if (typeof args.name !== "string" || !args.name.trim()) throw new Error("rack chain name must not be empty");
      return this.#confirmedMutation({ method: name, trackId: args.trackId, deviceId: args.deviceId,
        expectedStateVersion: args.expectedStateVersion, beforeDevice: rack, index, name: args.name }, args);
    }
    if (name === "list_device_parameters") {
      return this.bridge.request("list_device_parameters", args);
    }
    if (name === "komplete_get_status") return this.komplete.request("get_status", {});
    if (name === "komplete_verify_nks_preset") {
      return this.komplete.request("verify_nks_preset", args);
    }
    const kompleteMethod = {
      komplete_open_instrument: "open_instrument",
      komplete_load_source_preset: "load_source_preset",
      komplete_save_nks_preset: "save_nks_preset",
      komplete_run_conversion_batch: "run_conversion_batch",
      komplete_pause_batch: "pause_batch"
    }[name];
    if (kompleteMethod) return this.#kompleteMutation(kompleteMethod, args);
    if (name === "set_device_parameters") return this.#setDeviceParameters(args);
    if (name === "set_device_active" || name === "delete_device" || name === "move_device") return this.#deviceLifecycle(name, args);
    if (name === "set_song_musical_context") return this.#setSongMusicalContext(args);
    if (name === "set_groove") return this.#setGroove(args);
    if (name === "set_transport_recording_context") return this.#setTransportRecordingContext(args);
    if (["create_arrangement_cue_point", "rename_arrangement_cue_point", "delete_arrangement_cue_point", "jump_to_arrangement_cue_point"].includes(name)) {
      return this.#arrangementCuePointMutation(name, args);
    }
    if (name === "set_transport_context") return this.#setTransportContext(args);
    if (name === "set_clip_timing") return this.#setClipTiming(args);
    if (name === "create_track") return this.#createTrack(args);
    if (name === "create_scene") return this.#createScene(args);
    if (name === "rename_session_object") return this.#renameSessionObject(args);
    if (name === "duplicate_session_object") return this.#duplicateSessionObject(args);
    if (name === "delete_session_object") return this.#deleteSessionObject(args);
    if (name === "set_audio_clip_state") return this.#setAudioClipState(args);
    if (name === "move_audio_warp_marker") return this.#moveAudioWarpMarker(args);
    if (name === "remove_audio_warp_marker") return this.#removeAudioWarpMarker(args);
    if (name === "add_audio_warp_marker") return this.#addAudioWarpMarker(args);
    if (name === "quantize_audio_clip") return this.#quantizeAudioClip(args);
    if (name === "crop_audio_clip") return this.#cropAudioClip(args);
    if (name === "duplicate_clip") return this.#duplicateClip(args);
    if (name === "delete_clip") return this.#deleteClip(args);
    if (name === "duplicate_clip_loop") return this.#duplicateClipLoop(args);
    if (name === "create_midi_clip") return this.#createMidiClip(args);
    if (name === "create_audio_clip") return this.#createAudioClip(args);
    if (name === "set_clip_parameter_envelope") return this.#setClipParameterEnvelope(args);
    if (name === "set_midi_note_properties") return this.#setMidiNoteProperties(args);
    if (name === "transform_midi_notes") return this.#transformMidiNotes(args);
    if (name === "set_track_mixer") return this.#setTrackMixer(args);
    if (name === "set_track_routing") return this.#setTrackRouting(args);
    if (name === "set_device_sidechain_routing") return this.#setDeviceSidechainRouting(args);
    if (name === "set_group_fold_state") return this.#setGroupFoldState(args);
    if (name === "route_tracks_to_bus") return this.#routeTracksToBus(args);
    if (name === "load_browser_item" || name === "load_factory_browser_item") return this.#loadBrowserItem(name, args);
    if (name === "set_master_mixer" || name === "set_return_mixer") return this.#setBusMixer(name, args);
    if (name === "undo" || name === "redo") return this.#historyMutation(name, args);
    if ([
      "panic",
      "transport_play", "transport_stop", "set_tempo",
      "launch_scene", "launch_clip", "stop_clip", "arm_track"
    ].includes(name)) {
      return this.#genericMutation(name, args);
    }
    throw new Error(`unknown tool ${name}`);
  }

  async readResource(uri) {
    if (uri === "nks://catalog/products") return { products: this.catalog.products() };
    if (uri.startsWith("nks://catalog/presets/")) {
      return { preset: this.catalog.get(decodeURIComponent(uri.slice("nks://catalog/presets/".length))) };
    }
    if (uri.startsWith("nks://catalog/artwork/")) {
      return {
        artwork: this.catalog.artwork(
          decodeURIComponent(uri.slice("nks://catalog/artwork/".length))
        )
      };
    }
    if (uri === "ableton://live/status") return this.bridge.request("get_live_state", {});
    if (uri === "ableton://live/transport") return this.bridge.request("get_transport_context", {});
    if (uri === "ableton://set/history") return this.bridge.request("get_history_state", {});
    if (uri === "ableton://set/musical-context") return this.bridge.request("get_song_musical_context", {});
    if (uri === "ableton://set/mixer") return this.bridge.request("get_set_mixer", {});
    if (uri === "ableton://set/tracks") return this.bridge.request("list_tracks", {});
    if (uri === "ableton://set/scenes") return this.bridge.request("list_scenes", {});
    if (uri === "komplete://automation/status") return this.komplete.request("get_status", {});
    const trackClips = uri.match(/^ableton:\/\/track\/([^/]+)\/clips$/);
    if (trackClips) return this.bridge.request("list_clips", { trackId: decodeURIComponent(trackClips[1]) });
    const trackRouting = uri.match(/^ableton:\/\/track\/([^/]+)\/routing$/);
    if (trackRouting) return this.bridge.request("get_track_routing", { trackId: decodeURIComponent(trackRouting[1]) });
    const clipTiming = uri.match(/^ableton:\/\/track\/([^/]+)\/clip\/([^/]+)\/timing$/);
    if (clipTiming) return this.bridge.request("get_clip_timing", {
      trackId: decodeURIComponent(clipTiming[1]), clipId: decodeURIComponent(clipTiming[2])
    });
    const audioClip = uri.match(/^ableton:\/\/track\/([^/]+)\/clip\/([^/]+)\/audio$/);
    if (audioClip) return this.bridge.request("get_audio_clip_state", {
      trackId: decodeURIComponent(audioClip[1]), clipId: decodeURIComponent(audioClip[2])
    });
    const trackDevices = uri.match(/^ableton:\/\/track\/([^/]+)\/devices$/);
    if (trackDevices) return this.bridge.request("list_devices", { trackId: decodeURIComponent(trackDevices[1]) });
    const deviceParameters = uri.match(/^ableton:\/\/device\/([^/]+)\/parameters$/);
    if (deviceParameters) {
      const deviceId = decodeURIComponent(deviceParameters[1]);
      const trackId = deviceId.split(":device-")[0];
      return this.bridge.request("list_device_parameters", { trackId, deviceId });
    }
    throw new Error(`unknown resource ${uri}`);
  }

  async #setDeviceParameters(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("list_device_parameters", {
      trackId: args.trackId,
      deviceId: args.deviceId
    });
    assertExpectedState(args, observed);
    const allowed = new Map(observed.parameters.map((parameter) => [parameter.id, parameter]));
    const changes = args.changes.map((change) => {
      const parameter = allowed.get(change.id);
      if (!parameter) throw new Error(`parameter ${change.id} is not allowlisted`);
      const value = Math.max(parameter.min, Math.min(parameter.max, Number(change.value)));
      return {
        id: change.id,
        name: parameter.name,
        originalName: parameter.originalName,
        previousValue: parameter.value,
        previousDisplayValue: parameter.displayValue,
        requestedValue: change.value,
        value,
        targetDisplayValue: targetDisplayValue(parameter, value)
      };
    });
    const plan = {
      method: "set_device_parameters",
      trackId: args.trackId,
      deviceId: args.deviceId,
      expectedStateVersion: args.expectedStateVersion,
      changes
    };
    if (args.dryRun !== false) {
      return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    }
    this.#consumeConfirmation(plan, args);
    const result = await this.bridge.request("set_device_parameters", plan);
    return {
      dryRun: false,
      requested: plan,
      observed: result,
      timestamp: new Date().toISOString(),
      rollback: "Recall the prior macro snapshot or restore the previous parameter values."
    };
  }

  async #observeDevice(args) {
    if (typeof args.deviceId === "string" && args.deviceId.includes("/")) {
      const observed = await this.bridge.request("get_device_hierarchy", { trackId: args.trackId, deviceId: args.deviceId });
      if (observed.device?.id !== args.deviceId) throw new Error(`unknown device ${args.deviceId}`);
      return observed;
    }
    const observed = await this.bridge.request("list_devices", { trackId: args.trackId });
    const device = observed.devices.find(({ id }) => id === args.deviceId);
    if (!device) throw new Error(`unknown device ${args.deviceId}`);
    return { ...observed, device };
  }

  async #deviceLifecycle(method, args) {
    requireExpectedState(args);
    if (method === "set_device_active" && typeof args.active !== "boolean") throw new Error("active must be boolean");
    const observed = await this.#observeDevice(args);
    assertExpectedState({ expectedStateVersion: args.expectedStateVersion, trackId: args.trackId }, observed);
    const device = observed.device;
    const plan = {
      method, trackId: args.trackId, deviceId: args.deviceId,
      expectedStateVersion: args.expectedStateVersion, beforeDevice: device
    };
    if (method === "set_device_active") plan.active = args.active;
    if (method === "move_device") {
      if (!Number.isSafeInteger(args.targetPosition) || args.targetPosition < 0) throw new Error("targetPosition must be a nonnegative integer");
      plan.targetPosition = args.targetPosition;
    }
    return this.#confirmedMutation(plan, args);
  }

  async #setGroove(args) {
    requireExpectedState(args);
    const before = await this.bridge.request("get_song_musical_context", {});
    assertExpectedState(args, before);
    const groove = before.groove.pool.find(item => item.id === args.grooveId);
    if (!groove) throw new Error(`unknown groove ${args.grooveId}`);
    const changes = {};
    if (args.baseGrid !== undefined) {
      const matches = (groove.baseGrid?.choices ?? []).filter(choice => choice.name === args.baseGrid || choice.value === args.baseGrid);
      if (matches.length !== 1) throw new Error("unknown groove base grid or native choices unavailable");
      changes.baseGrid = { previous: { value: groove.baseGrid.value, name: groove.baseGrid.name }, value: matches[0] };
    }
    for (const key of ["timingAmount", "quantizationAmount", "randomAmount", "velocityAmount"]) {
      if (args[key] !== undefined) changes[key] = { previous: groove[key], value: finiteRange(args[key], key, key === "velocityAmount" ? -100 : 0, 100) };
    }
    if (args.name !== undefined) {
      if (typeof args.name !== "string" || !args.name.trim()) throw new Error("groove name must be a non-empty string");
      changes.name = { previous: groove.name, value: args.name };
    }
    if (!Object.keys(changes).length) throw new Error("at least one groove change is required");
    return this.#confirmedMutation({ method: "set_groove", expectedStateVersion: args.expectedStateVersion,
      grooveId: args.grooveId, before, changes }, args);
  }

  async #historyMutation(method, args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_history_state", {});
    assertExpectedState(args, observed);
    const available = method === "undo" ? observed.canUndo : observed.canRedo;
    if (!available) throw new Error(`${method} is not available`);
    return this.#confirmedMutation({
      method, expectedStateVersion: args.expectedStateVersion, before: observed
    }, args);
  }

  async #setSongMusicalContext(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_song_musical_context", {});
    assertExpectedState(args, observed);
    const changes = {};
    const signature = normalizeSignature(args.timeSignature, "timeSignature");
    if (signature) changes.timeSignature = signature;
    if (args.key !== undefined) {
      const key = {};
      if (args.key.rootNote !== undefined) {
        const rootNote = Number(args.key.rootNote);
        if (!Number.isInteger(rootNote) || rootNote < 0 || rootNote > 11) throw new Error("key.rootNote must be an integer from 0 to 11");
        key.rootNote = rootNote;
      }
      if (args.key.scaleName !== undefined) {
        if (typeof args.key.scaleName !== "string" || !args.key.scaleName.trim()) throw new Error("key.scaleName must be a non-empty string");
        key.scaleName = args.key.scaleName;
      }
      if (args.key.scaleMode !== undefined) {
        if (typeof args.key.scaleMode !== "boolean") throw new Error("key.scaleMode must be boolean");
        key.scaleMode = args.key.scaleMode;
      }
      if (Object.keys(key).length) changes.key = key;
    }
    if (args.quantization !== undefined) {
      const quantization = {};
      if (args.quantization.clipTrigger !== undefined) quantization.clipTrigger = normalizeChoice(
        args.quantization.clipTrigger, "quantization.clipTrigger", observed.quantization.clipTrigger.choices
      );
      if (args.quantization.midiRecording !== undefined) quantization.midiRecording = normalizeChoice(
        args.quantization.midiRecording, "quantization.midiRecording", observed.quantization.midiRecording.choices
      );
      if (Object.keys(quantization).length) changes.quantization = quantization;
    }
    if (args.groove !== undefined) {
      const groove = {};
      if (args.groove.amount !== undefined) groove.amount = finiteRange(args.groove.amount, "groove.amount", 0, 1.3125);
      if (args.groove.swingAmount !== undefined) groove.swingAmount = finiteRange(args.groove.swingAmount, "groove.swingAmount", 0, 1);
      if (Object.keys(groove).length) changes.groove = groove;
    }
    if (args.loop !== undefined) {
      const loop = {};
      if (args.loop.enabled !== undefined) {
        if (typeof args.loop.enabled !== "boolean") throw new Error("loop.enabled must be boolean");
        loop.enabled = args.loop.enabled;
      }
      if (args.loop.startBeats !== undefined) loop.startBeats = finiteRange(args.loop.startBeats, "loop.startBeats", 0, Number.MAX_SAFE_INTEGER);
      if (args.loop.lengthBeats !== undefined) loop.lengthBeats = finiteRange(args.loop.lengthBeats, "loop.lengthBeats", Number.EPSILON, Number.MAX_SAFE_INTEGER);
      if (Object.keys(loop).length) changes.loop = loop;
    }
    if (!Object.keys(changes).length) throw new Error("at least one musical context change is required");
    return this.#confirmedMutation({ method: "set_song_musical_context", expectedStateVersion: args.expectedStateVersion, before: observed, changes }, args);
  }

  async #setTransportRecordingContext(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_transport_recording_context", {});
    assertExpectedState(args, observed);
    const changes = {};
    if (args.currentSongTime !== undefined) changes.currentSongTime = finiteRange(args.currentSongTime, "currentSongTime", 0, Number.MAX_SAFE_INTEGER);
    const metronome = optionalBoolean(args.metronome, "metronome");
    const automationArm = optionalBoolean(args.automationArm, "automationArm");
    if (metronome !== undefined) changes.metronome = metronome;
    if (automationArm !== undefined) changes.automationArm = automationArm;
    for (const [group, fields] of Object.entries({
      arrangement: ["record", "overdub", "punchIn", "punchOut", "backToArranger"],
      session: ["record", "overdub"]
    })) {
      if (args[group] === undefined) continue;
      const values = {};
      for (const field of fields) {
        const value = optionalBoolean(args[group][field], `${group}.${field}`);
        if (value !== undefined) values[field] = value;
      }
      if (Object.keys(values).length) changes[group] = values;
    }
    if (!Object.keys(changes).length) throw new Error("at least one transport recording context change is required");
    return this.#confirmedMutation({
      method: "set_transport_recording_context", expectedStateVersion: args.expectedStateVersion,
      before: observed, changes
    }, args);
  }

  async #setTransportContext(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_transport_context", {});
    assertExpectedState(args, observed);
    const changes = {};
    if (args.metronome !== undefined) {
      if (typeof args.metronome !== "boolean") throw new Error("metronome must be boolean");
      changes.metronome = { previous: observed.metronome, value: args.metronome };
    }
    if (args.countInDuration !== undefined) changes.countInDuration = {
      previous: observed.countInDuration.value,
      value: normalizeChoice(args.countInDuration, "countInDuration", observed.countInDuration.choices)
    };
    if (!Object.keys(changes).length) throw new Error("at least one transport context change is required");
    return this.#confirmedMutation({
      method: "set_transport_context", expectedStateVersion: args.expectedStateVersion,
      before: observed, changes
    }, args);
  }

  async #arrangementCuePointMutation(method, args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("list_arrangement_cue_points", {});
    assertExpectedState(args, observed);
    const plan = { method, expectedStateVersion: args.expectedStateVersion, before: observed };
    if (method === "create_arrangement_cue_point") {
      plan.timeBeats = finiteRange(args.timeBeats, "timeBeats", 0, Number.MAX_SAFE_INTEGER);
      if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name must be a non-empty string");
      plan.name = args.name.trim();
    } else {
      const cuePoint = observed.cuePoints.find(({ id }) => id === args.cuePointId);
      if (!cuePoint) throw new Error(`unknown cue point ${args.cuePointId}`);
      plan.cuePointId = args.cuePointId;
      plan.beforeCuePoint = cuePoint;
      if (method === "rename_arrangement_cue_point") {
        if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name must be a non-empty string");
        plan.name = args.name.trim();
      }
    }
    return this.#confirmedMutation(plan, args);
  }

  async #setClipTiming(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_clip_timing", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, observed);
    const changes = {};
    if (args.loop !== undefined) {
      if (observed.loop.unit === "seconds" && (args.loop.startBeats !== undefined || args.loop.endBeats !== undefined)) {
        throw new Error("beat-based loop positions cannot be applied to unwarped audio");
      }
      const loop = {};
      if (args.loop.enabled !== undefined) {
        if (typeof args.loop.enabled !== "boolean") throw new Error("loop.enabled must be boolean");
        loop.enabled = args.loop.enabled;
      }
      const seconds = observed.loop.unit === "seconds";
      if (!seconds && (args.loop.startSeconds !== undefined || args.loop.endSeconds !== undefined)) throw new Error("seconds-based loop positions require unwarped audio");
      const startKey = seconds ? "startSeconds" : "startBeats";
      const endKey = seconds ? "endSeconds" : "endBeats";
      const start = args.loop[startKey] === undefined ? observed.loop[startKey] : finiteRange(args.loop[startKey], `loop.${startKey}`, 0, Number.MAX_SAFE_INTEGER);
      const end = args.loop[endKey] === undefined ? observed.loop[endKey] : finiteRange(args.loop[endKey], `loop.${endKey}`, 0, Number.MAX_SAFE_INTEGER);
      if (end <= start) throw new Error(`loop.${endKey} must be greater than loop.${startKey}`);
      if (args.loop[startKey] !== undefined) loop[startKey] = start;
      if (args.loop[endKey] !== undefined) loop[endKey] = end;
      if (Object.keys(loop).length) changes.loop = loop;
    }
    const signature = normalizeSignature(args.timeSignature, "timeSignature");
    if (signature) changes.timeSignature = signature;
    if (args.launchQuantization !== undefined) changes.launchQuantization = normalizeChoice(
      args.launchQuantization, "launchQuantization", observed.launchQuantization.choices
    );
    if (args.grooveId !== undefined) {
      if (typeof args.grooveId !== "string") throw new Error("grooveId must identify an available groove");
      if (!observed.availableGrooves.some(({ id }) => id === args.grooveId)) throw new Error(`unknown groove ${args.grooveId}`);
      changes.grooveId = args.grooveId;
    }
    if (!Object.keys(changes).length) throw new Error("at least one clip timing change is required");
    return this.#confirmedMutation({
      method: "set_clip_timing", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before: observed, changes
    }, args);
  }

  async #setAudioClipState(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_audio_clip_state", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, observed);
    const changes = {};
    if (args.gain !== undefined) {
      const requested = Number(args.gain);
      if (!Number.isFinite(requested)) throw new Error("gain must be finite");
      changes.gain = { previous: observed.gain.value, requested, value: Math.max(observed.gain.min, Math.min(observed.gain.max, requested)) };
    }
    for (const [argument, field, min, max] of [
      ["pitchCoarse", "coarse", -48, 48], ["pitchFine", "fine", -50, 50]
    ]) {
      if (args[argument] === undefined) continue;
      const value = Number(args[argument]);
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${argument} must be an integer from ${min} to ${max}`);
      changes[argument] = { previous: observed.pitch[field], value };
    }
    if (args.warping !== undefined) {
      if (typeof args.warping !== "boolean") throw new Error("warping must be boolean");
      changes.warping = { previous: observed.warping, value: args.warping };
    }
    if (args.warpMode !== undefined) changes.warpMode = {
      previous: observed.warpMode.value,
      value: normalizeChoice(args.warpMode, "warpMode", observed.warpMode.choices)
    };
    const markerKeys = ["startMarkerBeats", "endMarkerBeats", "startMarkerSeconds", "endMarkerSeconds"];
    const requested = markerKeys.filter((key) => args[key] !== undefined);
    if (requested.length) {
      const suffix = observed.warping ? "Beats" : "Seconds";
      const startKey = `startMarker${suffix}`, endKey = `endMarker${suffix}`;
      if (args.warping !== undefined || requested.some((key) => key !== startKey && key !== endKey)) {
        throw new Error("marker units must match current warping; change warping separately");
      }
      const start = args[startKey] === undefined ? observed.markers[`start${suffix}`] : finiteRange(args[startKey], startKey, 0, Number.MAX_SAFE_INTEGER);
      const end = args[endKey] === undefined ? observed.markers[`end${suffix}`] : finiteRange(args[endKey], endKey, 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`${endKey} must be greater than ${startKey}`);
      if (args[startKey] !== undefined) changes[startKey] = { previous: observed.markers[`start${suffix}`], value: start };
      if (args[endKey] !== undefined) changes[endKey] = { previous: observed.markers[`end${suffix}`], value: end };
    }
    if (!Object.keys(changes).length) throw new Error("at least one audio clip change is required");
    return this.#confirmedMutation({
      method: "set_audio_clip_state", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before: observed, changes
    }, args);
  }

  async #cropAudioClip(args) {
    requireExpectedState(args);
    const before = await this.bridge.request("get_audio_clip_state", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, before);
    if (!before.loop || !before.markers) throw new Error("native audio crop interval unavailable");
    const fromLoop = before.loop.enabled;
    const region = fromLoop ? before.loop : before.markers;
    if (!["beats", "seconds"].includes(region.unit)) throw new Error("unknown audio crop units");
    const suffix = region.unit === "beats" ? "Beats" : "Seconds";
    const start = region[`start${suffix}`], end = region[`end${suffix}`];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("invalid audio crop interval");
    return this.#confirmedMutation({ method: "crop_audio_clip", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before,
      selectedRegion: { unit: region.unit, start, end, fromLoop } }, args);
  }

  async #quantizeAudioClip(args) {
    requireExpectedState(args);
    const before = await this.bridge.request("get_audio_clip_state", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, before);
    if (!before.warping || !before.warpMarkers?.supported) throw new Error("warped audio marker API required");
    if (!["1_4", "1_8", "1_8_triplet", "1_8_and_triplet", "1_16", "1_16_triplet", "1_16_and_triplet", "1_32"].includes(args.grid)) {
      throw new Error("unsupported audio quantization grid");
    }
    const amount = finiteRange(args.amount, "amount", 0, 1);
    const context = await this.bridge.request("get_song_musical_context", {});
    assertExpectedState({ expectedStateVersion: args.expectedStateVersion }, context);
    const beforeSwingAmount = finiteRange(context.groove?.swingAmount, "observed swing amount", 0, 1);
    return this.#confirmedMutation({ method: "quantize_audio_clip", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before, beforeSwingAmount, grid: args.grid, amount }, args);
  }

  async #addAudioWarpMarker(args) {
    requireExpectedState(args);
    const before = await this.bridge.request("get_audio_clip_state", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, before);
    if (!before.warping || !before.warpMarkers?.supported) throw new Error("warped audio marker API required");
    if (!Number.isFinite(args.beatTime)) throw new Error("marker beat time must be a finite number");
    if (before.warpMarkers.markers.some(marker => marker.beatTime === args.beatTime)) throw new Error("warp marker already exists at beat time");
    const plan = { method: "add_audio_warp_marker", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before, beatTime: args.beatTime };
    if (args.sampleTime !== undefined) {
      if (!Number.isFinite(args.sampleTime) || args.sampleTime < 0) throw new Error("sampleTime must be a finite nonnegative number");
      plan.sampleTime = args.sampleTime;
    }
    return this.#confirmedMutation(plan, args);
  }

  async #removeAudioWarpMarker(args) {
    requireExpectedState(args);
    const before = await this.bridge.request("get_audio_clip_state", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, before);
    if (!before.warping || !before.warpMarkers?.supported) throw new Error("warped audio marker API required");
    if (!Number.isFinite(args.beatTime)) throw new Error("marker beat time must be a finite number");
    const markers = before.warpMarkers.markers;
    const index = markers.findIndex(marker => marker.beatTime === args.beatTime);
    if (index < 0 || index === markers.length - 1) throw new Error("unknown or hidden terminal warp marker");
    return this.#confirmedMutation({ method: "remove_audio_warp_marker", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before, beatTime: args.beatTime }, args);
  }

  async #moveAudioWarpMarker(args) {
    requireExpectedState(args);
    const before = await this.bridge.request("get_audio_clip_state", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, before);
    if (!before.warping || !before.warpMarkers?.supported) throw new Error("warped audio marker API required");
    const beatTime = args.beatTime, targetBeatTime = args.targetBeatTime;
    if (!Number.isFinite(beatTime) || !Number.isFinite(targetBeatTime)) throw new Error("marker beat times must be finite numbers");
    const markers = before.warpMarkers.markers;
    const index = markers.findIndex(marker => marker.beatTime === beatTime);
    if (index < 0 || index === markers.length - 1) throw new Error("unknown or hidden terminal warp marker");
    if ((index > 0 && targetBeatTime <= markers[index - 1].beatTime) || (index < markers.length - 2 && targetBeatTime >= markers[index + 1].beatTime)) {
      throw new Error("warp marker cannot cross or overlap a neighbor");
    }
    if (beatTime === targetBeatTime) throw new Error("warp marker movement must change beat time");
    return this.#confirmedMutation({ method: "move_audio_warp_marker", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before, beatTime, targetBeatTime }, args);
  }

  async #duplicateClip(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("list_clips", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const source = observed.clips.find(({ id }) => id === args.sourceClipId);
    const target = observed.clips.find(({ id }) => id === args.targetClipId);
    if (!source) throw new Error(`unknown sourceClipId ${args.sourceClipId}`);
    if (!target) throw new Error(`unknown targetClipId ${args.targetClipId}`);
    if (!source.hasClip) throw new Error("source clip is empty");
    if (target.hasClip) throw new Error("target clip must be empty");
    if (source.id === target.id) throw new Error("source and target clips must differ");
    return this.#confirmedMutation({
      method: "duplicate_clip", trackId: args.trackId,
      sourceClipId: source.id, targetClipId: target.id,
      expectedStateVersion: args.expectedStateVersion, source, target
    }, args);
  }

  async #placeSessionClipInArrangement(args) {
    requireExpectedState(args);
    const session = await this.bridge.request("list_clips", { trackId: args.trackId });
    assertExpectedState(args, session);
    const source = session.clips.find(({ id }) => id === args.clipId);
    if (!source?.hasClip) throw new Error("source clip is empty or unknown");
    const startBeats = finiteRange(args.startBeats, "startBeats", 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(source.lengthBeats) || source.lengthBeats <= 0) throw new Error("source clip length is unavailable");
    const endBeats = startBeats + source.lengthBeats;
    if (!Number.isSafeInteger(Math.ceil(endBeats))) throw new Error("placement end exceeds supported beat range");
    const timeline = await this.bridge.request("list_arrangement_clips", { trackId: args.trackId });
    assertExpectedState(args, timeline);
    if (timeline.clips.some((clip) => startBeats < clip.endBeats && endBeats > clip.startBeats)) throw new Error("placement would overlap existing Arrangement clips");
    return this.#confirmedMutation({ method: "place_session_clip_in_arrangement", trackId: args.trackId,
      clipId: args.clipId, expectedStateVersion: args.expectedStateVersion, startBeats, endBeats, source,
      beforeArrangement: timeline.clips }, args);
  }

  async #deleteClip(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("list_clips", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const clip = observed.clips.find(({ id }) => id === args.clipId);
    if (!clip) throw new Error(`unknown clipId ${args.clipId}`);
    if (!clip.hasClip) throw new Error("clip is empty");
    return this.#confirmedMutation({
      method: "delete_clip", trackId: args.trackId, clipId: clip.id,
      expectedStateVersion: args.expectedStateVersion, before: clip
    }, args);
  }

  async #mutateArrangementClip(method, args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("list_arrangement_clips", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const before = observed.clips.find(({ id }) => id === args.clipId);
    if (!before) throw new Error(`unknown Arrangement clip ID ${args.clipId}`);
    const plan = { method, trackId: args.trackId, clipId: args.clipId, expectedStateVersion: args.expectedStateVersion, before };
    if (method === "move_arrangement_clip") {
      plan.startBeats = finiteRange(args.startBeats, "startBeats", 0, Number.MAX_SAFE_INTEGER);
      const end = plan.startBeats + before.lengthBeats;
      if (!Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER || before.lengthBeats <= 0) throw new Error("move interval is invalid");
      if (observed.clips.some((clip) => clip.id !== before.id && plan.startBeats < clip.endBeats && end > clip.startBeats)) throw new Error("move would overlap another Arrangement clip");
      plan.beforeArrangement = observed.clips;
    }
    return this.#confirmedMutation(plan, args);
  }

  async #duplicateClipLoop(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_clip_timing", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, observed);
    if (!observed.loop.enabled) throw new Error("clip looping must be enabled before duplicating its loop");
    return this.#confirmedMutation({
      method: "duplicate_clip_loop", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, before: observed
    }, args);
  }

  #consumeConfirmation(plan, args) {
    const currentHash = hashPlan(plan);
    if (args.planHash !== undefined && args.planHash !== currentHash) throw new Error("confirmation plan hash mismatch: observed plan changed");
    return this.confirmations.consume(args.confirmationToken, currentHash);
  }

  async #confirmedMutation(plan, args) {
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.#consumeConfirmation(plan, args);
    const observed = await this.bridge.request(plan.method, plan);
    return { dryRun: false, requested: plan, observed, timestamp: new Date().toISOString() };
  }

  async #setPresetMetadata(args) {
    if (!Number.isInteger(args.expectedMetadataRevision) || args.expectedMetadataRevision < 0) {
      throw new Error("expectedMetadataRevision is required for preset metadata mutations");
    }
    if (args.favorite === undefined && args.tags === undefined) throw new Error("favorite or tags is required");
    const changes = {};
    if (args.favorite !== undefined) changes.favorite = args.favorite;
    if (args.tags !== undefined) changes.tags = args.tags;
    const update = this.catalog.planMetadataUpdate(args.presetId, args.expectedMetadataRevision, changes);
    const plan = {
      method: "set_preset_metadata", presetId: args.presetId,
      expectedMetadataRevision: args.expectedMetadataRevision,
      before: update.before, after: update.after
    };
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.#consumeConfirmation(plan, args);
    const observed = this.catalog.setMetadata(args.presetId, args.expectedMetadataRevision, changes);
    return { dryRun: false, requested: plan, observed, timestamp: new Date().toISOString() };
  }

  async #createTrack(args) {
    requireExpectedState(args);
    if (!["midi", "audio"].includes(args.type)) throw new Error("type must be midi or audio");
    const observed = await this.bridge.request("list_tracks", {});
    assertExpectedState(args, observed);
    const index = args.index === undefined ? observed.tracks.length : Number(args.index);
    if (!Number.isInteger(index) || index < 0 || index > observed.tracks.length) throw new Error("index is outside the track insertion range");
    return this.#confirmedMutation({
      method: "create_track", expectedStateVersion: args.expectedStateVersion,
      type: args.type, index, name: sessionName(args.name), before: insertionContext(observed.tracks, index)
    }, args);
  }

  async #createScene(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("list_scenes", {});
    assertExpectedState(args, observed);
    const index = args.index === undefined ? observed.scenes.length : Number(args.index);
    if (!Number.isInteger(index) || index < 0 || index > observed.scenes.length) throw new Error("index is outside the scene insertion range");
    return this.#confirmedMutation({
      method: "create_scene", expectedStateVersion: args.expectedStateVersion,
      index, name: sessionName(args.name), before: insertionContext(observed.scenes, index)
    }, args);
  }

  async #renameSessionObject(args) {
    requireExpectedState(args);
    const name = sessionName(args.name);
    if (args.targetType === "clip") {
      const observed = await this.bridge.request("list_clips", { trackId: args.trackId });
      assertExpectedState(args, observed);
      const clip = observed.clips.find(({ id }) => id === args.targetId);
      if (!clip) throw new Error(`unknown clip slot ${args.targetId}`);
      if (!clip.hasClip) throw new Error(`empty clip slot ${args.targetId}`);
      return this.#confirmedMutation({
        method: "rename_session_object", expectedStateVersion: args.expectedStateVersion,
        target: { targetType: "clip", trackId: args.trackId, targetId: args.targetId, previousName: clip.name, name }
      }, args);
    }
    if (!["track", "scene"].includes(args.targetType)) throw new Error("targetType must be track, scene, or clip");
    const observed = args.targetType === "track" ? await this.bridge.request("list_tracks", {})
      : await this.bridge.request("list_scenes", {});
    assertExpectedState(args, observed);
    const items = args.targetType === "track" ? observed.tracks : observed.scenes;
    const target = items.find(({ id }) => id === args.targetId);
    if (!target) throw new Error(`unknown ${args.targetType} ${args.targetId}`);
    return this.#confirmedMutation({
      method: "rename_session_object", expectedStateVersion: args.expectedStateVersion,
      target: { targetType: args.targetType, targetId: args.targetId, previousName: target.name, name }
    }, args);
  }

  async #duplicateSessionObject(args) {
    requireExpectedState(args);
    if (args.targetType === "track") {
      if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim())) {
        throw new Error("name must be a non-empty string");
      }
      const observed = await this.bridge.request("list_tracks", {});
      assertExpectedState({ expectedStateVersion: args.expectedStateVersion }, observed);
      const index = observed.tracks.findIndex(({ id }) => id === args.targetId);
      if (index === -1) throw new Error(`unknown track ${args.targetId}`);
      const source = observed.tracks[index];
      return this.#confirmedMutation({
        method: "duplicate_session_object", expectedStateVersion: args.expectedStateVersion,
        target: { targetType: "track", targetId: source.id, sourceName: source.name, name: args.name?.trim() || source.name,
          destinationId: `track-${index + 1}`, displaced: observed.tracks[index + 1] || null }
      }, args);
    }
    if (args.targetType === "clip") {
      const observed = await this.bridge.request("list_clips", { trackId: args.trackId });
      assertExpectedState(args, observed);
      const index = observed.clips.findIndex(({ id }) => id === args.targetId);
      if (index === -1) throw new Error(`unknown clip slot ${args.targetId}`);
      const source = observed.clips[index];
      if (!source.hasClip) throw new Error(`empty clip slot ${args.targetId}`);
      const destination = observed.clips[index + 1];
      if (!destination) throw new Error("clip duplication requires a following clip slot");
      if (destination.hasClip) throw new Error(`destination clip slot ${destination.id} is occupied`);
      return this.#confirmedMutation({
        method: "duplicate_session_object", expectedStateVersion: args.expectedStateVersion,
        target: { targetType: "clip", trackId: args.trackId, targetId: source.id,
          name: source.name, destinationId: destination.id }
      }, args);
    }
    if (args.targetType !== "scene") throw new Error("targetType must be track, scene, or clip");
    const observed = await this.bridge.request("list_scenes", {});
    assertExpectedState(args, observed);
    const index = observed.scenes.findIndex(({ id }) => id === args.targetId);
    if (index === -1) throw new Error(`unknown scene ${args.targetId}`);
    const source = observed.scenes[index];
    return this.#confirmedMutation({
      method: "duplicate_session_object", expectedStateVersion: args.expectedStateVersion,
      target: { targetType: "scene", targetId: source.id, name: source.name,
        destinationId: `scene-${index + 1}`, displaced: observed.scenes[index + 1] || null }
    }, args);
  }

  async #deleteSessionObject(args) {
    requireExpectedState(args);
    if (args.targetType === "clip") {
      const observed = await this.bridge.request("list_clips", { trackId: args.trackId });
      assertExpectedState(args, observed);
      const clip = observed.clips.find(({ id }) => id === args.targetId);
      if (!clip) throw new Error(`unknown clip slot ${args.targetId}`);
      if (!clip.hasClip) throw new Error(`empty clip slot ${args.targetId}`);
      return this.#confirmedMutation({ method: "delete_session_object",
        expectedStateVersion: args.expectedStateVersion,
        target: { targetType: "clip", trackId: args.trackId, targetId: clip.id, name: clip.name }
      }, args);
    }
    if (args.targetType === "track") {
      const observed = await this.bridge.request("list_tracks", {});
      assertExpectedState(args, observed);
      if (observed.tracks.length <= 1) throw new Error("cannot delete the last track");
      const track = observed.tracks.find(({ id }) => id === args.targetId);
      if (!track) throw new Error(`unknown track ${args.targetId}`);
      const clips = (await this.bridge.request("list_clips", { trackId: track.id })).clips
        .filter(({ hasClip }) => hasClip).map(({ id, name }) => ({ id, name }));
      const devices = (await this.bridge.request("list_devices", { trackId: track.id })).devices;
      if ((clips.length || devices.length) && args.allowContent !== true) {
        throw new Error("allowContent: true is required to delete a track containing clips or devices");
      }
      return this.#confirmedMutation({ method: "delete_session_object",
        expectedStateVersion: args.expectedStateVersion,
        target: { targetType: "track", targetId: track.id, name: track.name,
          clipCount: clips.length, deviceCount: devices.length, clips, devices }
      }, args);
    }
    if (args.targetType !== "scene") throw new Error("targetType must be track, scene, or clip");
    const observed = await this.bridge.request("list_scenes", {});
    assertExpectedState(args, observed);
    if (observed.scenes.length <= 1) throw new Error("cannot delete the last scene");
    const sceneIndex = observed.scenes.findIndex(({ id }) => id === args.targetId);
    if (sceneIndex === -1) throw new Error(`unknown scene ${args.targetId}`);
    const tracks = (await this.bridge.request("list_tracks", {})).tracks;
    const occupiedClips = [];
    for (const track of tracks) {
      const slot = (await this.bridge.request("list_clips", { trackId: track.id })).clips[sceneIndex];
      if (slot?.hasClip) occupiedClips.push({ trackId: track.id, clipId: slot.id, name: slot.name });
    }
    if (occupiedClips.length && args.allowContent !== true) {
      throw new Error("allowContent: true is required to delete a scene containing clips");
    }
    const scene = observed.scenes[sceneIndex];
    return this.#confirmedMutation({ method: "delete_session_object",
      expectedStateVersion: args.expectedStateVersion,
      target: { targetType: "scene", targetId: scene.id, name: scene.name, occupiedClips }
    }, args);
  }

  async #createMidiClip(args) {
    requireExpectedState(args);
    const lengthBeats = Number(args.lengthBeats);
    if (!Number.isFinite(lengthBeats) || lengthBeats <= 0) throw new Error("lengthBeats must be greater than zero");
    if (!Array.isArray(args.notes)) throw new Error("notes must be an array");
    if (args.name !== undefined && typeof args.name !== "string") throw new Error("name must be a string");
    const observed = await this.bridge.request("list_clips", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const slot = observed.clips.find((clip) => clip.id === args.clipId);
    if (!slot) throw new Error(`unknown clip slot ${args.clipId}`);
    if (slot.hasClip) throw new Error(`clip slot ${args.clipId} already contains a clip`);
    const plan = {
      method: "create_midi_clip",
      trackId: args.trackId,
      clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion,
      lengthBeats,
      notes: args.notes.map((note, index) => normalizeMidiNote(note, index, lengthBeats))
    };
    if (args.name !== undefined) plan.name = args.name;
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.#consumeConfirmation(plan, args);
    const result = await this.bridge.request("create_midi_clip", plan);
    return { dryRun: false, requested: plan, observed: result, timestamp: new Date().toISOString() };
  }

  async #createAudioClip(args) {
    requireExpectedState(args);
    if (typeof args.sourcePath !== "string" || !isAbsolute(args.sourcePath)) throw new Error("sourcePath must be an absolute local audio-file path");
    const sourcePath = await realpath(args.sourcePath);
    const source = await stat(sourcePath, { bigint: true });
    if (!source.isFile()) throw new Error("sourcePath must reference a regular file");
    const sourceFile = { size: String(source.size), mtimeNs: String(source.mtimeNs), device: String(source.dev), inode: String(source.ino) };
    const observed = await this.bridge.request("list_clips", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const slot = observed.clips.find(({ id }) => id === args.clipId);
    if (!slot) throw new Error(`unknown clip slot ${args.clipId}`);
    if (slot.hasClip) throw new Error("clip slot already contains a clip");
    const plan = { method: "create_audio_clip", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, sourcePath, sourceFile };
    if (args.name !== undefined) plan.name = args.name;
    return this.#confirmedMutation(plan, args);
  }

  async #setClipParameterEnvelope(args) {
    requireExpectedState(args);
    if (!Array.isArray(args.points) || args.points.length === 0) {
      throw new Error("points must be a non-empty array");
    }
    const sampleTimes = args.points.map(({ time }) => Number(time));
    const observed = await this.bridge.request("get_clip_parameter_envelope", {
      trackId: args.trackId,
      clipId: args.clipId,
      deviceId: args.deviceId,
      parameterId: args.parameterId,
      sampleTimes
    });
    assertExpectedState(args, observed);
    if (!observed.parameter?.enabled) throw new Error(`parameter ${args.parameterId} is disabled`);
    const plan = {
      method: "set_clip_parameter_envelope",
      trackId: args.trackId,
      clipId: args.clipId,
      deviceId: args.deviceId,
      parameterId: args.parameterId,
      expectedStateVersion: args.expectedStateVersion,
      points: args.points.map((point, index) => normalizeEnvelopePoint(
        point, index, observed.clipLengthBeats, observed.parameter
      ))
    };
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.#consumeConfirmation(plan, args);
    const result = await this.bridge.request("set_clip_parameter_envelope", plan);
    return { dryRun: false, requested: plan, observed: result, timestamp: new Date().toISOString() };
  }

  async #setMidiNoteProperties(args) {
    requireExpectedState(args);
    if (!Array.isArray(args.changes) || args.changes.length === 0) throw new Error("changes must be a non-empty array");
    const observed = await this.bridge.request("get_midi_clip_notes_extended", {
      trackId: args.trackId, clipId: args.clipId
    });
    assertExpectedState(args, observed);
    const notes = new Map(observed.notes.map((note) => [note.noteId, note]));
    const plan = {
      method: "set_midi_note_properties", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion,
      changes: args.changes.map((change, index) => {
        const current = notes.get(change.noteId);
        if (!current) throw new Error(`unknown noteId ${change.noteId}`);
        return normalizeMidiNoteChange(change, index, current, observed.lengthBeats);
      })
    };
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.#consumeConfirmation(plan, args);
    const result = await this.bridge.request("set_midi_note_properties", plan);
    return { dryRun: false, requested: plan, observed: result, timestamp: new Date().toISOString() };
  }

  async #transformMidiNotes(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_midi_clip_notes_extended", {
      trackId: args.trackId, clipId: args.clipId
    });
    assertExpectedState(args, observed);
    const transformed = transformMidiNotes(observed, args.noteIds, args.operation);
    const plan = {
      method: "transform_midi_notes", trackId: args.trackId, clipId: args.clipId,
      expectedStateVersion: args.expectedStateVersion, operation: args.operation,
      changes: transformed.changes, newNotes: transformed.newNotes
    };
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.#consumeConfirmation(plan, args);
    const result = await this.bridge.request("transform_midi_notes", plan);
    return { dryRun: false, requested: plan, observed: result, timestamp: new Date().toISOString() };
  }

  async #setTrackMixer(args) {
    requireExpectedState(args);
    const hasScalar = ["volume", "pan", "mute", "solo"].some((key) => args[key] !== undefined);
    if (!hasScalar && (!Array.isArray(args.sends) || args.sends.length === 0)) {
      throw new Error("at least one mixer change is required");
    }
    const observed = await this.bridge.request("get_track_mixer", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const changes = {};
    for (const key of ["volume", "pan"]) {
      if (args[key] === undefined) continue;
      const requestedValue = Number(args[key]);
      if (!Number.isFinite(requestedValue)) throw new Error(`${key} must be finite`);
      changes[key] = {
        previousValue: observed[key].value, requestedValue,
        value: Math.max(observed[key].min, Math.min(observed[key].max, requestedValue))
      };
    }
    for (const key of ["mute", "solo"]) {
      if (args[key] === undefined) continue;
      if (typeof args[key] !== "boolean") throw new Error(`${key} must be boolean`);
      changes[key] = { previousValue: observed[key], value: args[key] };
    }
    if (args.sends !== undefined) {
      if (!Array.isArray(args.sends)) throw new Error("sends must be an array");
      const sends = new Map(observed.sends.map((send) => [send.id, send]));
      const seen = new Set();
      changes.sends = args.sends.map((change) => {
        const send = sends.get(change.id);
        if (!send) throw new Error(`unknown send ${change.id}`);
        if (seen.has(change.id)) throw new Error(`duplicate send ${change.id}`);
        seen.add(change.id);
        const requestedValue = Number(change.value);
        if (!Number.isFinite(requestedValue)) throw new Error(`send ${change.id} value must be finite`);
        return {
          id: send.id, returnTrackId: send.returnTrackId, name: send.name,
          previousValue: send.value, requestedValue,
          value: Math.max(send.min, Math.min(send.max, requestedValue))
        };
      });
    }
    const plan = {
      method: "set_track_mixer", trackId: args.trackId,
      expectedStateVersion: args.expectedStateVersion, changes
    };
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.#consumeConfirmation(plan, args);
    const result = await this.bridge.request("set_track_mixer", plan);
    return { dryRun: false, requested: plan, observed: result, timestamp: new Date().toISOString() };
  }

  async #setDeviceSidechainRouting(args) {
    requireExpectedState(args);
    const keys = ["sourceTypeId", "sourceChannelId"].filter(key => args[key] !== undefined);
    if (keys.length !== 1) throw new Error("exactly one sidechain source type or channel change is required");
    const key = keys[0];
    if (typeof args[key] !== "string") throw new Error(`${key} must be a string`);
    const before = await this.bridge.request("get_device_sidechain_routing", { trackId: args.trackId, deviceId: args.deviceId });
    assertExpectedState(args, before);
    if (!before.sidechain.supported) throw new Error("device sidechain routing is unsupported");
    const isType = key === "sourceTypeId";
    const matches = before.sidechain[isType ? "availableTypes" : "availableChannels"].filter(option => option.id === args[key]);
    if (!matches.length) throw new Error(`unknown ${key} ${args[key]}`);
    if (matches.length !== 1) throw new Error(`ambiguous ${key} ${args[key]}`);
    return this.#confirmedMutation({ method: "set_device_sidechain_routing", trackId: args.trackId,
      deviceId: args.deviceId, expectedStateVersion: args.expectedStateVersion, before,
      changes: { [key]: { previous: before.sidechain[isType ? "type" : "channel"], value: matches[0] } } }, args);
  }

  async #setTrackRouting(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_track_routing", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const changes = {};
    for (const [argument, section, field] of [
      ["inputTypeId", "input", "type"], ["inputChannelId", "input", "channel"],
      ["outputTypeId", "output", "type"], ["outputChannelId", "output", "channel"]
    ]) {
      if (args[argument] === undefined) continue;
      if (typeof args[argument] !== "string") throw new Error(`${argument} must be a string`);
      const choices = observed[section][field === "type" ? "availableTypes" : "availableChannels"];
      const selected = choices.find(({ id }) => id === args[argument]);
      if (!selected) throw new Error(`unknown ${argument} ${args[argument]}`);
      changes[argument] = { previous: observed[section][field], value: selected };
    }
    if (args.monitoring !== undefined) {
      const selected = observed.monitoring.choices.find(({ name, value }) => name === args.monitoring || value === args.monitoring);
      if (!selected) throw new Error(`unknown monitoring ${args.monitoring}`);
      changes.monitoring = { previous: { value: observed.monitoring.value, name: observed.monitoring.name }, value: selected };
    }
    if (!Object.keys(changes).length) throw new Error("at least one routing change is required");
    return this.#confirmedMutation({
      method: "set_track_routing", trackId: args.trackId,
      expectedStateVersion: args.expectedStateVersion, changes
    }, args);
  }

  async #setGroupFoldState(args) {
    requireExpectedState(args);
    if (typeof args.folded !== "boolean") throw new Error("folded must be a boolean");
    const observed = await this.bridge.request("list_tracks", {});
    assertExpectedState({ expectedStateVersion: args.expectedStateVersion }, observed);
    const track = observed.tracks.find(({ id }) => id === args.trackId);
    if (!track) throw new Error(`unknown trackId ${args.trackId}`);
    if (!track.isGroup) throw new Error(`track ${args.trackId} is not a group`);
    return this.#confirmedMutation({
      method: "set_group_fold_state", expectedStateVersion: args.expectedStateVersion,
      trackId: args.trackId, folded: args.folded, before: track
    }, args);
  }

  async #routeTracksToBus(args) {
    requireExpectedState(args);
    if (!Array.isArray(args.trackIds) || !args.trackIds.length) throw new Error("trackIds must be a non-empty array");
    if (new Set(args.trackIds).size !== args.trackIds.length) throw new Error("trackIds must be unique");
    if (args.trackIds.includes(args.busTrackId)) throw new Error("a group bus cannot route to itself");
    const observed = await this.bridge.request("list_tracks", {});
    assertExpectedState(args, observed);
    const bus = observed.tracks.find(({ id }) => id === args.busTrackId);
    if (!bus) throw new Error(`unknown busTrackId ${args.busTrackId}`);
    if (!bus.isGroup) throw new Error(`track ${args.busTrackId} is not a group bus`);
    const routes = [];
    for (const trackId of args.trackIds) {
      if (!observed.tracks.some(({ id }) => id === trackId)) throw new Error(`unknown trackId ${trackId}`);
      const routing = await this.bridge.request("get_track_routing", { trackId });
      assertExpectedState(args, routing);
      const matches = routing.output.availableTypes.filter(({ id, name }) => id === args.busTrackId || name === bus.name);
      if (matches.length !== 1) throw new Error(`group bus ${args.busTrackId} is not an unambiguous output routing choice for ${trackId}`);
      routes.push({ trackId, outputTypeId: matches[0].id, before: routing.output.type });
    }
    return this.#confirmedMutation({
      method: "route_tracks_to_bus", expectedStateVersion: args.expectedStateVersion,
      busTrackId: args.busTrackId, bus, routes
    }, args);
  }

  async #loadBrowserItem(method, args) {
    requireExpectedState(args);
    const browserPath = normalizeBrowserPath(args);
    if (!browserPath.path.length) throw new Error("Live browser item is not loadable");
    const observed = await this.bridge.request("list_devices", { trackId: args.trackId });
    assertExpectedState(args, observed);
    const listMethod = method === "load_browser_item" ? "get_browser_items" : "get_factory_browser_items";
    const listing = await this.bridge.request(listMethod, browserPath);
    if (!listing.item.loadable) throw new Error(`Live browser item ${listing.item.name} is not loadable`);
    return this.#confirmedMutation({
      method, trackId: args.trackId,
      expectedStateVersion: args.expectedStateVersion,
      root: browserPath.root, path: browserPath.path, item: listing.item,
      loadBehavior: {
        mayReplaceExistingDevices: observed.devices.length > 0,
        existingDeviceIds: observed.devices.map(({ id }) => id),
        warning: "Live browser loading may replace an existing instrument or rack rather than append. Inspect the existing device hierarchy in before; use a separate staging track and move_device_to_chain to build additional rack layers."
      },
      before: observed
    }, args);
  }

  async #setBusMixer(method, args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_set_mixer", {});
    assertExpectedState({ expectedStateVersion: args.expectedStateVersion }, observed);
    const target = method === "set_master_mixer"
      ? observed.master
      : observed.returns.find(({ id }) => id === args.returnTrackId);
    if (!target) throw new Error(`unknown return track ${args.returnTrackId}`);
    const numericKeys = method === "set_master_mixer"
      ? ["volume", "pan", "cueVolume", "crossfader"]
      : ["volume", "pan"];
    const booleanKeys = method === "set_return_mixer" ? ["mute", "solo"] : [];
    const changes = {};
    if (method === "set_master_mixer" && args.outputChannelId !== undefined) {
      const routing = target.outputRouting;
      const selected = routing?.availableChannels.find(({ id }) => id === args.outputChannelId);
      if (!routing?.supported || !selected) throw new Error("master output channel is unavailable");
      changes.outputChannelId = { previous: routing.channel, value: selected };
    }
    for (const key of numericKeys) {
      if (args[key] === undefined) continue;
      const requestedValue = Number(args[key]);
      if (!Number.isFinite(requestedValue)) throw new Error(`${key} must be finite`);
      changes[key] = {
        previousValue: target[key].value, requestedValue,
        value: Math.max(target[key].min, Math.min(target[key].max, requestedValue))
      };
    }
    for (const key of booleanKeys) {
      if (args[key] === undefined) continue;
      if (typeof args[key] !== "boolean") throw new Error(`${key} must be boolean`);
      changes[key] = { previousValue: target[key], value: args[key] };
    }
    if (!Object.keys(changes).length) {
      throw new Error(`at least one ${method === "set_master_mixer" ? "master" : "return"} mixer change is required`);
    }
    const plan = { method, expectedStateVersion: args.expectedStateVersion, changes };
    if (method === "set_master_mixer") plan.beforeMaster = target;
    else {
      plan.returnTrackId = args.returnTrackId;
      plan.beforeReturn = target;
    }
    return this.#confirmedMutation(plan, args);
  }

  async #genericMutation(name, args) {
    requireExpectedState(args);
    const current = await this.bridge.request("get_live_state", {});
    assertExpectedState(args, current);
    const plan = { method: name, ...args };
    delete plan.dryRun;
    delete plan.confirmationToken;
    delete plan.planHash;
    if (args.dryRun !== false) {
      return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    }
    this.#consumeConfirmation(plan, args);
    const observed = await this.bridge.request(name, plan);
    return { dryRun: false, requested: plan, observed, timestamp: new Date().toISOString() };
  }

  async #kompleteMutation(method, args) {
    requireExpectedSession(args);
    const current = await this.komplete.request("get_status", {});
    if (current.sessionVersion !== args.expectedSessionVersion) {
      throw new Error(
        `sessionVersion mismatch: expected ${args.expectedSessionVersion}, observed ${current.sessionVersion}`
      );
    }
    const plan = { method, ...args };
    delete plan.dryRun;
    delete plan.confirmationToken;
    delete plan.planHash;
    if (args.dryRun !== false) {
      return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    }
    this.#consumeConfirmation(plan, args);
    const observed = await this.komplete.request(method, plan);
    return { dryRun: false, requested: plan, observed, timestamp: new Date().toISOString() };
  }
}
