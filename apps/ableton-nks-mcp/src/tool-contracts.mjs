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
const metadataGuarded = (properties = {}, required = []) => object({
  ...properties,
  expectedMetadataRevision: { type: "integer", minimum: 0, description: "Exact preset metadata revision observed immediately before planning." },
  dryRun: confirmation.dryRun, confirmationToken: confirmation.confirmationToken, planHash: confirmation.planHash,
}, ["expectedMetadataRevision", ...required]);
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
  search_presets: { description: "Search the optional local NKS preset catalog.", inputSchema: object({ productSlug: string("Product slug."), query: string("Name query."), category: string("Normalized category."), favorite: boolean("Return only favorites or non-favorites."), tags: array(string("Normalized user tag."), "Require every supplied tag."), limit: { type: "integer", minimum: 1 } }) },
  get_preset: { description: "Read one exact NKS preset catalog record.", inputSchema: object({ presetId: ids.presetId }, ["presetId"]) },
  get_preset_metadata: { description: "Read user tags, favorite state, and revision for one preset.", inputSchema: object({ presetId: ids.presetId }, ["presetId"]) },
  set_preset_metadata: { description: "Plan or update user tags and favorite state for one preset with an exact revision guard.", inputSchema: metadataGuarded({ presetId: ids.presetId, favorite: boolean("Favorite state."), tags: array(string("User tag."), "Complete replacement tag set.") }, ["presetId"]) },
  get_live_state: { description: "Read Ableton bridge identity, capabilities, tempo, playback, and state version.", inputSchema: empty },
  get_history_state: { description: "Read current Ableton undo and redo availability.", inputSchema: empty },
  undo: { description: "Plan or apply one guarded Ableton undo operation.", inputSchema: guarded() },
  redo: { description: "Plan or apply one guarded Ableton redo operation.", inputSchema: guarded() },
  get_transport_context: { description: "Read transport playback, metronome, and count-in state.", inputSchema: empty },
  set_transport_context: { description: "Plan or apply guarded metronome and count-in changes.", inputSchema: guarded({ metronome: boolean("Metronome enabled."), countInDuration: choice("Count-in duration value or name.") }) },
  get_transport_recording_context: { description: "Read playhead and Arrangement, Session, and automation recording state.", inputSchema: empty },
  set_transport_recording_context: { description: "Plan or apply guarded playhead and recording-mode changes.", inputSchema: guarded({ currentSongTime: number("Playhead position in beats.", { minimum: 0 }), arrangement: object({ record: boolean("Arrangement record."), overdub: boolean("Arrangement overdub."), punchIn: boolean("Punch-in."), punchOut: boolean("Punch-out."), backToArranger: boolean("Back-to-Arrangement state.") }), session: object({ record: boolean("Session record."), overdub: boolean("Session overdub.") }), automationArm: boolean("Automation arm.") }) },
  get_song_musical_context: { description: "Read key, scale, time signature, quantization, groove, swing, and Arrangement loop context.", inputSchema: empty },
  set_song_musical_context: { description: "Plan or apply guarded song key, scale, timing, quantization, groove, swing, or loop changes.", inputSchema: guarded({
    timeSignature: object({ numerator: { type: "integer", minimum: 1 }, denominator: { type: "integer", enum: [1, 2, 4, 8, 16] } }),
    key: object({ rootNote: { type: "integer", minimum: 0, maximum: 11 }, scaleName: string("Live scale name."), scaleMode: boolean("Enable Live scale mode.") }),
    quantization: object({ clipTrigger: choice("Clip-trigger quantization value or name."), midiRecording: choice("MIDI-recording quantization value or name.") }), groove: object({ amount: number("Groove amount.", { minimum: 0, maximum: 1 }), swingAmount: number("Swing amount.", { minimum: 0, maximum: 1 }) }),
    loop: object({ enabled: boolean("Arrangement loop enabled."), startBeats: number("Loop start.", { minimum: 0 }), lengthBeats: number("Loop length.", { exclusiveMinimum: 0 }) }),
  }) },
  list_arrangement_cue_points: { description: "List Arrangement cue points with stable IDs and beat positions.", inputSchema: empty },
  create_arrangement_cue_point: { description: "Plan or create an Arrangement cue point at an exact beat position.", inputSchema: guarded({ name: string("Cue-point name."), timeBeats: number("Cue-point position in beats.", { minimum: 0 }) }, ["name", "timeBeats"]) },
  rename_arrangement_cue_point: { description: "Plan or rename one exact Arrangement cue point.", inputSchema: guarded({ cuePointId: string("Stable cue-point ID."), name: string("New cue-point name.") }, ["cuePointId", "name"]) },
  delete_arrangement_cue_point: { description: "Plan or delete one exact Arrangement cue point.", inputSchema: guarded({ cuePointId: string("Stable cue-point ID.") }, ["cuePointId"]) },
  jump_to_arrangement_cue_point: { description: "Plan or move the playhead to one exact Arrangement cue point.", inputSchema: guarded({ cuePointId: string("Stable cue-point ID.") }, ["cuePointId"]) },
  list_tracks: { description: "List stable Ableton track identities, mixer state, and existing group hierarchy.", inputSchema: empty },
  list_scenes: { description: "List stable Session scene identities and state.", inputSchema: empty },
  list_clips: { description: "List clip slots and clips on one exact track.", inputSchema: track },
  create_track: { description: "Plan or create an audio or MIDI track at an exact insertion index.", inputSchema: guarded({ type: { type: "string", enum: ["audio", "midi"] }, index: { type: "integer", minimum: 0 }, name: string("Track name.") }, ["type", "name"]) },
  create_scene: { description: "Plan or create a Session scene at an exact insertion index.", inputSchema: guarded({ index: { type: "integer", minimum: 0 }, name: string("Scene name.") }, ["name"]) },
  rename_session_object: { description: "Plan or rename an exact track, scene, or Session clip.", inputSchema: guarded({ targetType: { type: "string", enum: ["track", "scene", "clip"] }, targetId: string("Stable target ID."), trackId: ids.trackId, name: string("New name.") }, ["targetType", "targetId", "name"]) },
  duplicate_session_object: { description: "Plan or duplicate an exact track, Session scene, or clip, optionally naming a duplicated track.", inputSchema: guarded({ targetType: { type: "string", enum: ["track", "scene", "clip"] }, targetId: string("Stable source ID."), trackId: ids.trackId, name: string("Optional name for a duplicated track.") }, ["targetType", "targetId"]) },
  delete_session_object: { description: "Plan or delete an exact track, scene, or Session clip with explicit content authority.", inputSchema: guarded({ targetType: { type: "string", enum: ["track", "scene", "clip"] }, targetId: string("Stable target ID."), trackId: ids.trackId, allowContent: boolean("Allow deletion when clips or devices are present.") }, ["targetType", "targetId"]) },
  get_midi_clip_notes: { description: "Read standard MIDI notes from one Session clip.", inputSchema: clip },
  get_midi_clip_notes_extended: { description: "Read stable note IDs, probability, release velocity, deviation, and other per-note fields.", inputSchema: clip },
  get_clip_timing: { description: "Read clip loop, signature, launch quantization, and groove assignment.", inputSchema: clip },
  set_clip_timing: { description: "Plan or apply guarded clip loop, signature, quantization, and groove changes.", inputSchema: guarded({
    trackId: ids.trackId, clipId: ids.clipId,
    loop: object({ enabled: boolean("Clip loop enabled."), startBeats: number("Loop start.", { minimum: 0 }), endBeats: number("Loop end.", { exclusiveMinimum: 0 }) }),
    timeSignature: object({ numerator: { type: "integer", minimum: 1 }, denominator: { type: "integer", enum: [1, 2, 4, 8, 16] } }),
    launchQuantization: choice("Launch quantization value or name."), grooveId: string("Groove ID returned by get_clip_timing."),
  }, ["trackId", "clipId"]) },
  get_audio_clip_state: { description: "Read gain, pitch, warp, and marker state for one exact audio clip.", inputSchema: clip },
  set_audio_clip_state: { description: "Plan or apply guarded audio-clip gain, pitch, warp, and marker changes.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, gain: number("Clip gain."), pitchCoarse: { type: "integer", minimum: -48, maximum: 48 }, pitchFine: { type: "integer", minimum: -50, maximum: 50 }, warping: boolean("Warp enabled."), warpMode: choice("Warp mode value or name."), startMarkerBeats: number("Start marker in beats.", { minimum: 0 }), endMarkerBeats: number("End marker in beats.", { minimum: 0 }) }, ["trackId", "clipId"]) },
  duplicate_clip: { description: "Plan or duplicate an exact occupied Session clip into an exact empty slot.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, destinationClipId: ids.clipId }, ["trackId", "clipId", "destinationClipId"]) },
  delete_clip: { description: "Plan or delete one exact occupied Session clip.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  duplicate_clip_loop: { description: "Plan or duplicate the current loop region of one exact clip.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId }, ["trackId", "clipId"]) },
  get_automation_capabilities: { description: "Report exact supported and unsupported automation and per-note expression surfaces.", inputSchema: empty },
  get_track_mixer: { description: "Read bounded track volume, pan, mute, solo, and named return sends.", inputSchema: track },
  get_track_routing: { description: "Read exact input, output, and monitoring choices for one track.", inputSchema: track },
  set_track_routing: { description: "Plan or apply guarded track routing and monitoring changes by exact choice ID.", inputSchema: guarded({ trackId: ids.trackId, inputTypeId: string("Input routing type ID."), inputChannelId: string("Input routing channel ID."), outputTypeId: string("Output routing type ID."), outputChannelId: string("Output routing channel ID."), monitoring: choice("Monitoring mode value or name.") }, ["trackId"]) },
  set_group_fold_state: { description: "Plan or apply the folded state of one exact existing group track.", inputSchema: guarded({ trackId: ids.trackId, folded: boolean("Whether the group is folded.") }, ["trackId", "folded"]) },
  route_tracks_to_bus: { description: "Plan or route existing tracks to one exact existing group bus using Live's available routing choices.", inputSchema: guarded({ trackIds: array(ids.trackId, "Source track IDs."), busTrackId: ids.trackId }, ["trackIds", "busTrackId"]) },
  get_set_mixer: { description: "Read master and return-bus mixer state.", inputSchema: empty },
  list_arrangement_clips: { description: "Read timeline clip IDs, types, and start/end positions in beats for one track.", inputSchema: object({ trackId: ids.trackId }, ["trackId"]) },
  create_audio_clip: { description: "Plan or import a local audio file into one exact empty Session slot on an unfrozen audio track. The confirmed plan binds the source file identity, size, and modification time; Live validates the audio format.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, sourcePath: string("Absolute local audio-file path."), name: string("Optional imported clip name.") }, ["trackId", "clipId", "sourcePath"]) },
  move_arrangement_clip: { description: "Plan or move one exact Arrangement clip to a new beat position, preserving its span with staged copies, rollback, and an isolated undo step. Rejects collisions with other clips; self-overlap is supported.", inputSchema: guarded({ trackId: ids.trackId, clipId: string("Exact timeline clip ID from list_arrangement_clips."), startBeats: number("New nonnegative timeline position in beats.", { minimum: 0 }) }, ["trackId", "clipId", "startBeats"]) },
  delete_arrangement_clip: { description: "Plan or delete one exact Arrangement clip, preserving other timeline material. Requires current clip identity and confirmation; deletion is undoable in Live.", inputSchema: guarded({ trackId: ids.trackId, clipId: string("Exact timeline clip ID returned by list_arrangement_clips.") }, ["trackId", "clipId"]) },
  place_session_clip_in_arrangement: { description: "Plan or copy a Session clip onto its track's Arrangement timeline. Rejects overlap with existing timeline material.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, startBeats: number("Nonnegative Arrangement start in beats.", { minimum: 0 }) }, ["trackId", "clipId", "startBeats"]) },
  move_device: { description: "Plan or reorder one exact device within its current track or rack chain. Live may choose the nearest valid position; read actualPosition and the new device ID from the result.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, targetPosition: { type: "integer", minimum: 0, description: "Device-chain insertion index; zero is first." } }, ["trackId", "deviceId", "targetPosition"]) },
  set_master_mixer: { description: "Plan or apply guarded master mixer and available hardware output-channel changes.", inputSchema: guarded({ outputChannelId: string("Exact available master output channel ID from get_set_mixer."), volume: number("Master volume."), pan: number("Master pan.", { minimum: -1, maximum: 1 }), cueVolume: number("Cue volume."), crossfader: number("Crossfader position.", { minimum: -1, maximum: 1 }) }) },
  set_return_mixer: { description: "Plan or apply guarded return-bus volume, pan, mute, or solo changes.", inputSchema: guarded({ returnTrackId: string("Stable return-track ID."), volume: number("Return volume."), pan: number("Return pan.", { minimum: -1, maximum: 1 }), mute: boolean("Mute return."), solo: boolean("Solo return.") }, ["returnTrackId"]) },
  list_factory_device_profiles: { description: "List producer-oriented knowledge profiles for foundational Ableton factory devices.", inputSchema: empty },
  get_factory_device_context: { description: "Combine a loaded device's Live parameters with matched factory-device production knowledge.", inputSchema: device },
  get_factory_browser_items: { description: "Browse one exact level of a Live factory browser root.", inputSchema: object({ root: string("Factory browser root."), path: array(string("Exact browser path segment."), "Path below the root.") }, ["root"]) },
  load_factory_browser_item: { description: "Plan or load one exact factory browser item onto a guarded target track.", inputSchema: guarded({ trackId: ids.trackId, root: string("Factory browser root."), path: array(string("Exact browser path segment."), "Path to the loadable item.") }, ["trackId", "root", "path"]) },
  get_browser_items: { description: "Browse one exact level of Live's factory, plug-in, Pack, Max for Live, project, or user-content browser.", inputSchema: object({ root: string("Live browser root."), path: array(string("Exact browser path segment."), "Path below the root.") }, ["root"]) },
  load_browser_item: { description: "Plan or load one exact Live browser item onto a guarded target track.", inputSchema: guarded({ trackId: ids.trackId, root: string("Live browser root."), path: array(string("Exact browser path segment."), "Path to the loadable item.") }, ["trackId", "root", "path"]) },
  search_browser_items: { description: "Search a bounded subtree of Live's browser and return exact paths usable by load_browser_item.", inputSchema: object({ root: string("Live browser root."), path: array(string("Exact browser path segment."), "Optional subtree path."), query: string("Case-insensitive item-name query."), maxDepth: { type: "integer", minimum: 1, maximum: 16 }, limit: { type: "integer", minimum: 1, maximum: 200 } }, ["root", "query"]) },
  get_device_hierarchy: { description: "Read recursive rack chains and populated Drum Rack pads for one device.", inputSchema: device },
  get_clip_parameter_envelope: { description: "Sample one Session clip parameter envelope at exact beat positions.", inputSchema: object({ trackId: ids.trackId, clipId: ids.clipId, deviceId: ids.deviceId, parameterId: ids.parameterId, sampleTimes: array(number("Beat position.", { minimum: 0 }), "Beat positions to sample.") }, ["trackId", "clipId", "deviceId", "parameterId"]) },
  list_devices: { description: "List loaded devices on one exact track.", inputSchema: track },
  set_device_active: { description: "Plan or set the active state of one exact loaded device.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, active: boolean("Requested active state.") }, ["trackId", "deviceId", "active"]) },
  delete_device: { description: "Plan or delete one exact loaded device.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId }, ["trackId", "deviceId"]) },
  list_device_parameters: { description: "List exact live parameter IDs, values, bounds, labels, and quantized choices.", inputSchema: device },
  set_device_parameters: { description: "Plan or apply guarded bounded changes to exact loaded-device parameters.", inputSchema: guarded({ trackId: ids.trackId, deviceId: ids.deviceId, changes: array(object({ id: ids.parameterId, value: number("Requested value; clamped to live bounds.") }, ["id", "value"]), "Parameter changes.") }, ["trackId", "deviceId", "changes"]) },
  create_midi_clip: { description: "Plan or create a MIDI clip in an exact empty Session slot.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, lengthBeats: number("Clip length.", { exclusiveMinimum: 0 }), name: string("Optional clip name."), notes: array(note, "Initial MIDI notes.") }, ["trackId", "clipId", "lengthBeats", "notes"]) },
  set_clip_parameter_envelope: { description: "Plan or replace one Session clip parameter envelope with exact step data.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, deviceId: ids.deviceId, parameterId: ids.parameterId, points: array(envelopePoint, "Replacement envelope steps.") }, ["trackId", "clipId", "deviceId", "parameterId", "points"]) },
  set_midi_note_properties: { description: "Plan or apply guarded per-note timing, velocity, probability, mute, and pitch changes by stable note ID.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, changes: array(object({ noteId: { type: "integer" }, pitch: { type: "integer", minimum: 0, maximum: 127 }, start: number("Start beat.", { minimum: 0 }), duration: number("Duration.", { exclusiveMinimum: 0 }), velocity: { type: "integer", minimum: 1, maximum: 127 }, velocityDeviation: { type: "integer", minimum: -127, maximum: 127 }, releaseVelocity: { type: "integer", minimum: 0, maximum: 127 }, probability: number("Playback probability.", { minimum: 0, maximum: 1 }), mute: boolean("Mute note.") }, ["noteId"]), "Exact note changes.") }, ["trackId", "clipId", "changes"]) },
  transform_midi_notes: { description: "Plan or apply guarded quantize, legato, or duplicate transforms to exact MIDI note IDs.", inputSchema: guarded({ trackId: ids.trackId, clipId: ids.clipId, operation: object({ type: { type: "string", enum: ["quantize", "legato", "duplicate"] }, gridBeats: number("Quantization grid in beats; fractional values support triplets.", { exclusiveMinimum: 0 }), strength: number("Quantization strength.", { minimum: 0, maximum: 1 }), target: { type: "string", enum: ["start", "end", "both"], description: "Quantize absolute note starts, ends, or both; defaults to start." }, quantizeDuration: boolean("Legacy duration-grid quantization; cannot combine with end or both."), gapBeats: number("Legato gap in beats.", { minimum: 0 }), offsetBeats: number("Duplication offset in beats.", { exclusiveMinimum: 0 }), repeats: { type: "integer", minimum: 1, maximum: 16, description: "Duplication repeat count; defaults to one." } }, ["type"]), noteIds: array({ type: "integer" }, "Stable note IDs.") }, ["trackId", "clipId", "operation", "noteIds"]) },
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
