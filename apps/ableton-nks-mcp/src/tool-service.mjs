import { assertExpectedState } from "./bridge-protocol.mjs";
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
    const changes = selected.map((note) => {
      const targetStart = Math.round(note.start / grid) * grid;
      const start = note.start + (targetStart - note.start) * strength;
      const change = { noteId: note.noteId, previous: note, start };
      if (operation.quantizeDuration === true) {
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
    if (name === "get_live_state") return this.bridge.request("get_live_state", {});
    if (name === "get_song_musical_context") return this.bridge.request("get_song_musical_context", {});
    if (name === "list_tracks") return this.bridge.request("list_tracks", {});
    if (name === "list_scenes") return this.bridge.request("list_scenes", {});
    if (name === "list_clips") return this.bridge.request("list_clips", args);
    if (name === "get_midi_clip_notes") return this.bridge.request("get_midi_clip_notes", args);
    if (name === "get_midi_clip_notes_extended") return this.bridge.request("get_midi_clip_notes_extended", args);
    if (name === "get_track_mixer") return this.bridge.request("get_track_mixer", args);
    if (name === "list_factory_device_profiles") return { profiles: listFactoryDeviceProfiles() };
    if (name === "get_factory_device_context") {
      const devices = await this.bridge.request("list_devices", { trackId: args.trackId });
      const device = devices.devices.find(({ id }) => id === args.deviceId);
      if (!device) throw new Error(`unknown device ${args.deviceId}`);
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
    if (name === "list_devices") return this.bridge.request("list_devices", args);
    if (name === "get_device_hierarchy") return this.bridge.request("get_device_hierarchy", args);
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
    if (name === "set_song_musical_context") return this.#setSongMusicalContext(args);
    if (name === "set_clip_timing") return this.#setClipTiming(args);
    if (name === "create_track") return this.#createTrack(args);
    if (name === "create_scene") return this.#createScene(args);
    if (name === "rename_session_object") return this.#renameSessionObject(args);
    if (name === "duplicate_session_object") return this.#duplicateSessionObject(args);
    if (name === "delete_session_object") return this.#deleteSessionObject(args);
    if (name === "create_midi_clip") return this.#createMidiClip(args);
    if (name === "set_clip_parameter_envelope") return this.#setClipParameterEnvelope(args);
    if (name === "set_midi_note_properties") return this.#setMidiNoteProperties(args);
    if (name === "transform_midi_notes") return this.#transformMidiNotes(args);
    if (name === "set_track_mixer") return this.#setTrackMixer(args);
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
    if (uri === "ableton://set/musical-context") return this.bridge.request("get_song_musical_context", {});
    if (uri === "ableton://set/tracks") return this.bridge.request("list_tracks", {});
    if (uri === "ableton://set/scenes") return this.bridge.request("list_scenes", {});
    if (uri === "komplete://automation/status") return this.komplete.request("get_status", {});
    const trackClips = uri.match(/^ableton:\/\/track\/([^/]+)\/clips$/);
    if (trackClips) return this.bridge.request("list_clips", { trackId: decodeURIComponent(trackClips[1]) });
    const clipTiming = uri.match(/^ableton:\/\/track\/([^/]+)\/clip\/([^/]+)\/timing$/);
    if (clipTiming) return this.bridge.request("get_clip_timing", {
      trackId: decodeURIComponent(clipTiming[1]), clipId: decodeURIComponent(clipTiming[2])
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
    const result = await this.bridge.request("set_device_parameters", plan);
    return {
      dryRun: false,
      requested: plan,
      observed: result,
      timestamp: new Date().toISOString(),
      rollback: "Recall the prior macro snapshot or restore the previous parameter values."
    };
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
      if (args.groove.amount !== undefined) groove.amount = finiteRange(args.groove.amount, "groove.amount", 0, 1);
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

  async #setClipTiming(args) {
    requireExpectedState(args);
    const observed = await this.bridge.request("get_clip_timing", { trackId: args.trackId, clipId: args.clipId });
    assertExpectedState(args, observed);
    const changes = {};
    if (args.loop !== undefined) {
      const loop = {};
      if (args.loop.enabled !== undefined) {
        if (typeof args.loop.enabled !== "boolean") throw new Error("loop.enabled must be boolean");
        loop.enabled = args.loop.enabled;
      }
      const start = args.loop.startBeats === undefined ? observed.loop.startBeats : finiteRange(args.loop.startBeats, "loop.startBeats", 0, Number.MAX_SAFE_INTEGER);
      const end = args.loop.endBeats === undefined ? observed.loop.endBeats : finiteRange(args.loop.endBeats, "loop.endBeats", 0, Number.MAX_SAFE_INTEGER);
      if (end <= start) throw new Error("loop.endBeats must be greater than loop.startBeats");
      if (args.loop.startBeats !== undefined) loop.startBeats = start;
      if (args.loop.endBeats !== undefined) loop.endBeats = end;
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

  async #confirmedMutation(plan, args) {
    if (args.dryRun !== false) return { dryRun: true, plan, confirmation: this.confirmations.issue(plan) };
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
    const observed = await this.bridge.request(plan.method, plan);
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
    if (args.targetType !== "scene") throw new Error("targetType must be scene or clip");
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
    const result = await this.bridge.request("create_midi_clip", plan);
    return { dryRun: false, requested: plan, observed: result, timestamp: new Date().toISOString() };
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
    const result = await this.bridge.request("set_track_mixer", plan);
    return { dryRun: false, requested: plan, observed: result, timestamp: new Date().toISOString() };
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
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
    this.confirmations.consume(args.confirmationToken, args.planHash || hashPlan(plan));
    const observed = await this.komplete.request(method, plan);
    return { dryRun: false, requested: plan, observed, timestamp: new Date().toISOString() };
  }
}
