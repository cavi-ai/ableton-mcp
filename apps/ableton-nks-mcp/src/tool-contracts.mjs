const string = (description) => ({ type: "string", description });
const number = (description, extra = {}) => ({ type: "number", description, ...extra });
const boolean = (description) => ({ type: "boolean", description });
const array = (items, description) => ({ type: "array", items, description });
const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const ids = {
  trackId: string("Stable track ID returned by list_tracks."),
  sceneId: string("Stable scene ID returned by list_scenes."),
  clipId: string("Stable clip-slot ID returned by list_clips."),
  deviceId: string("Stable device ID returned by list_devices."),
  parameterId: string("Stable parameter ID returned by list_device_parameters."),
  presetId: string("Stable NKS preset catalog ID."),
};
const confirmation = {
  expectedStateVersion: { type: "integer", minimum: 1, description: "Exact stateVersion observed immediately before planning." },
  dryRun: boolean("Omit or true to return a plan; false requires a valid confirmationToken."),
  confirmationToken: string("Short-lived, single-use token returned by the matching dry run."),
  planHash: string("Hash returned by the matching dry run."),
};
const guarded = (properties = {}, required = []) => object(
  { ...properties, ...confirmation }, ["expectedStateVersion", ...required]
);
const sessionGuarded = (properties = {}, required = []) => object({
  ...properties,
  expectedSessionVersion: { type: "integer", minimum: 1, description: "Exact Komplete sessionVersion observed immediately before planning." },
  dryRun: confirmation.dryRun, confirmationToken: confirmation.confirmationToken, planHash: confirmation.planHash,
}, ["expectedSessionVersion", ...required]);
const choice = (description) => ({ oneOf: [{ type: "integer" }, { type: "string" }], description });
const empty = object();
const track = object({ trackId: ids.trackId }, ["trackId"]);
const clip = object({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]);
const device = object({ trackId: ids.trackId, deviceId: ids.deviceId }, ["trackId", "deviceId"]);

const note = object({
  pitch: { type: "integer", minimum: 0, maximum: 127 }, start: number("Start in beats.", { minimum: 0 }),
  duration: number("Duration in beats.", { exclusiveMinimum: 0 }), velocity: { type: "integer", minimum: 1, maximum: 127 },
  mute: boolean("Whether the note is muted."),
}, ["pitch", "start", "duration", "velocity"]);
const envelopePoint = object({
  time: number("Step start in beats.", { minimum: 0 }), duration: number("Step duration in beats.", { exclusiveMinimum: 0 }),
  value: number("Requested parameter value; the service clamps to live bounds."),
}, ["time", "duration", "value"]);

export const toolContracts = {
  search_presets: { description: "Search the optional local NKS preset catalog.", inputSchema: object({ productSlug: string("Product slug."), query: string("Name query."), category: string("Normalized category."), limit: { type: "integer", minimum: 1 } }) },
  get_preset: { description: "Read one exact NKS preset catalog record.", inputSchema: object({ presetId: ids.presetId }, ["presetId"]) },
  get_live_state: { description: "Read Ableton bridge identity, capabilities, tempo, playback, and state version.", inputSchema: empty },
  get_song_musical_context: { description: "Read key, scale, time signature, quantization, groove, swing, and Arrangement loop context.", inputSchema: empty },
  set_song_musical_context: { description: "Plan or apply guarded song key, scale, timing, quantization, groove, swing, or loop changes.", inputSchema: guarded({
    timeSignature: object({ numerator: { type: "integer", minimum: 1 }, denominator: { type: "integer", enum: [1, 2, 4, 8, 16] } }),
    key: object({ rootNote: { type: "integer", minimum: 0, maximum: 11 }, scaleName: string("Live scale name."), scaleMode: boolean("Enable Live scale mode.") }),
    quantization: object({ clipTrigger: choice("Clip-trigger quantization value or name."), midiRecording: choice("MIDI-recording quantization value or name.") }), groove: object({ amount: number("Groove amount.", { minimum: 0, maximum: 1 }), swingAmount: number("Swing amount.", { minimum: 0, maximum: 1 }) }),
    loop: object({ enabled: boolean("Arrangement loop enabled."), startBeats: number("Loop start.", { minimum: 0 }), lengthBeats: number("Loop length.", { exclusiveMinimum: 0 }) }),
  }) },
  list_tracks: { description: "List stable Ableton track identities and basic state.", inputSchema: empty },
  list_scenes: { description: "List stable Session scene identities and state.", inputSchema: empty },
  list_clips: { description: "List clip slots and clips on one exact track.", inputSchema: track },
  get_midi_clip_notes: { description: "Read standard MIDI notes from one Session clip.", inputSchema: clip },
  get_midi_clip_notes_extended: { description: "Read stable note IDs, probability, release velocity, deviation, and other per-note fields.", inputSchema: clip },
  get_clip_timing: { description: "Read clip loop, signature, launch quantization, and groove assignment.", inputSchema: clip },
  set_clip_timing: { description: "Plan or apply guarded clip loop, signature, quantization, and groove changes.", inputSchema: guarded({
    trackId: ids.trackId, clipId: ids.clipId,
    loop: object({ enabled: boolean("Clip loop enabled."), startBeats: number("Loop start.", { minimum: 0 }), endBeats: number("Loop end.", { exclusiveMinimum: 0 }) }),
    timeSignature: object({ numerator: { type: "integer", minimum: 1 }, denominator: { type: "integer", enum: [1, 2, 4, 8, 16] } }),
    launchQuantization: choice("Launch quantization value or name."), grooveId: string("Groove ID returned by get_clip_timing."),
  }, ["trackId", "clipId"]) },
  get_automation_capabilities: { description: "Report exact supported and unsupported automation and per-note expression surfaces.", inputSchema: empty },
  get_track_mixer: { description: "Read bounded track volume, pan, mute, solo, and named return sends.", inputSchema: track },
  list_factory_device_profiles: { description: "List producer-oriented knowledge profiles for foundational Ableton factory devices.", inputSchema: empty },
  get_factory_device_context: { description: "Combine a loaded device's Live parameters with matched factory-device production knowledge.", inputSchema: device },
  get_device_hierarchy: { description: "Read recursive rack chains and populated Drum Rack pads for one device.", inputSchema: device },
  get_clip_parameter_envelope: { description: "Sample one Session clip parameter envelope at exact beat positions.", inputSchema: object({ trackId: ids.trackId, clipId: ids.clipId, deviceId: ids.deviceId, parameterId: ids.parameterId, sampleTimes: array(number("Beat position.", { minimum: 0 }), "Beat positions to sample.") }, ["trackId", "clipId", "deviceId", "parameterId"]) },
  list_devices: { description: "List loaded devices on one exact track.", inputSchema: track },
  list_device_parameters: { description: "List exact live parameter IDs, values, bounds, labels, and quantized choices.", inputSchema: device },
  set_device_parameters: { description: "Plan or apply guarded bounded changes to exact loaded-device parameters.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, changes: array(object({ id: ids.parameterId, value: number("Requested value; clamped to live bounds.") }, ["id", "value"]), "Parameter changes.") }, ["trackId", "deviceId", "changes"]) },
  create_midi_clip: { description: "Plan or create a MIDI clip in an exact empty Session slot.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, lengthBeats: number("Clip length.", { exclusiveMinimum: 0 }), name: string("Optional clip name."), notes: array(note, "Initial MIDI notes.") }, ["trackId", "clipId", "lengthBeats", "notes"]) },
  set_clip_parameter_envelope: { description: "Plan or replace one Session clip parameter envelope with exact step data.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, deviceId: ids.deviceId, parameterId: ids.parameterId, points: array(envelopePoint, "Replacement envelope steps.") }, ["trackId", "clipId", "deviceId", "parameterId", "points"]) },
  set_midi_note_properties: { description: "Plan or apply guarded per-note timing, velocity, probability, mute, and pitch changes by stable note ID.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, changes: array(object({ noteId: { type: "integer" }, pitch: { type: "integer", minimum: 0, maximum: 127 }, start: number("Start beat.", { minimum: 0 }), duration: number("Duration.", { exclusiveMinimum: 0 }), velocity: { type: "integer", minimum: 1, maximum: 127 }, velocityDeviation: { type: "integer", minimum: -127, maximum: 127 }, releaseVelocity: { type: "integer", minimum: 0, maximum: 127 }, probability: number("Playback probability.", { minimum: 0, maximum: 1 }), mute: boolean("Mute note.") }, ["noteId"]), "Exact note changes.") }, ["trackId", "clipId", "changes"]) },
  panic: { description: "Plan or stop Live playback immediately using the guarded panic operation.", inputSchema: guarded() },
  transport_play: { description: "Plan or start Ableton transport playback.", inputSchema: guarded() },
  transport_stop: { description: "Plan or stop Ableton transport playback.", inputSchema: guarded() },
  set_tempo: { description: "Plan or set song tempo within Live's accepted range.", inputSchema: guarded({ tempo: number("Tempo in BPM.", { minimum: 20, maximum: 999 }) }, ["tempo"]) },
  set_track_mixer: { description: "Plan or apply guarded track volume, pan, mute, solo, and return-send changes.", inputSchema: guarded({ trackId: ids.trackId, volume: number("Track volume."), pan: number("Track pan.", { minimum: -1, maximum: 1 }), mute: boolean("Mute track."), solo: boolean("Solo track."), sends: array(object({ id: string("Send ID."), value: number("Send value.") }, ["id", "value"]), "Named return-send changes.") }, ["trackId"]) },
  launch_scene: { description: "Plan or launch one exact Session scene.", inputSchema: guarded({ sceneId: ids.sceneId }, ["sceneId"]) },
  launch_clip: { description: "Plan or launch one exact Session clip slot.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  stop_clip: { description: "Plan or stop one exact Session clip slot.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  arm_track: { description: "Plan or set the record-arm state of one exact track.", inputSchema: guarded({ trackId: ids.trackId, armed: boolean("Requested arm state.") }, ["trackId", "armed"]) },
  komplete_get_status: { description: "Read current Komplete automation session state.", inputSchema: empty },
  komplete_open_instrument: { description: "Plan or open the instrument identified by an exact product slug in Komplete Kontrol.", inputSchema: sessionGuarded({ productSlug: string("Exact product slug.") }, ["productSlug"]) },
  komplete_load_source_preset: { description: "Plan or load one exact source preset in Komplete Kontrol.", inputSchema: sessionGuarded({ productSlug: string("Exact product slug."), sourcePath: string("Absolute source preset path."), presetId: ids.presetId }, ["sourcePath"]) },
  komplete_save_nks_preset: { description: "Plan or save the currently loaded sound as an NKS preset.", inputSchema: sessionGuarded({ productSlug: string("Exact product slug."), destinationPath: string("Absolute NKS destination path."), name: string("Preset name."), presetId: ids.presetId }, ["destinationPath"]) },
  komplete_verify_nks_preset: { description: "Verify an exact indexed NKS preset without changing Komplete state.", inputSchema: object({ fileName: string("Exact NKS filename."), productSlug: string("Expected product slug.") }, ["fileName"]) },
  komplete_run_conversion_batch: { description: "Plan or start an exact Komplete conversion job batch.", inputSchema: sessionGuarded({ jobs: array({ type: "object", additionalProperties: true }, "Worker-defined conversion job records.") }, ["jobs"]) },
  komplete_pause_batch: { description: "Plan or pause the active Komplete conversion batch.", inputSchema: sessionGuarded() },
};
