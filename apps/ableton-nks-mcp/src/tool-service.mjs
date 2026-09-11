import { assertExpectedState } from "./bridge-protocol.mjs";
import { ConfirmationStore, hashPlan } from "./confirmation-store.mjs";
import { CatalogService } from "./catalog-service.mjs";

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
    if (name === "list_tracks") return this.bridge.request("list_tracks", {});
    if (name === "list_scenes") return this.bridge.request("list_scenes", {});
    if (name === "list_clips") return this.bridge.request("list_clips", args);
    if (name === "get_midi_clip_notes") return this.bridge.request("get_midi_clip_notes", args);
    if (name === "get_midi_clip_notes_extended") return this.bridge.request("get_midi_clip_notes_extended", args);
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
    if (name === "list_devices") return this.bridge.request("list_devices", args);
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
    if (name === "create_midi_clip") return this.#createMidiClip(args);
    if (name === "set_clip_parameter_envelope") return this.#setClipParameterEnvelope(args);
    if (name === "set_midi_note_properties") return this.#setMidiNoteProperties(args);
    if ([
      "panic",
      "transport_play", "transport_stop", "set_tempo", "set_track_mixer",
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
    if (uri === "ableton://set/tracks") return this.bridge.request("list_tracks", {});
    if (uri === "ableton://set/scenes") return this.bridge.request("list_scenes", {});
    if (uri === "komplete://automation/status") return this.komplete.request("get_status", {});
    const trackClips = uri.match(/^ableton:\/\/track\/([^/]+)\/clips$/);
    if (trackClips) return this.bridge.request("list_clips", { trackId: decodeURIComponent(trackClips[1]) });
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
