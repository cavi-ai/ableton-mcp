import { result, text, numeric, bool, integer, version, array, nullable, strings, integers, records, versioned } from "./result-schemas.mjs";

const object = { type: "object" };
const identity = { schemaVersion: { const: 1 }, name: text, version: text,
  sourceSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, fileCount: { type: "integer", minimum: 1 } };
const parameter = result({ value: numeric, min: numeric, max: numeric, displayValue: nullable(text), decibels: nullable(numeric),
  enabled: bool, silent: bool, automationState: object }, ["value"]);
export const midiNoteResult = result({ noteId: integer, pitch: { type: "integer", minimum: 0, maximum: 127 }, start: numeric,
  duration: numeric, velocity: { type: "integer", minimum: 0, maximum: 127 }, mute: bool,
  probability: { type: "number", minimum: 0, maximum: 1 }, velocityDeviation: integer, releaseVelocity: { type: "integer", minimum: 0, maximum: 127 }
}, ["noteId", "pitch", "start", "duration", "velocity", "mute"]);
const notes = array(midiNoteResult);
const target = { trackId: text, clipId: nullable(text), deviceId: nullable(text), setFingerprint: text };
const route = result({ type: nullable(object), channel: nullable(object), availableTypes: records, availableChannels: records }, []);
const mixer = { trackId: text, volume: parameter, pan: parameter, mute: bool, solo: bool, sends: array(result({ id: text, value: numeric,
  returnTrackId: text, name: text, decibels: nullable(numeric), silent: bool }, ["id", "value"])) };
const timing = { ...target, location: text, timeline: nullable(object),
  loop: result({ enabled: bool, unit: text, startBeats: numeric, endBeats: numeric, startSeconds: numeric, endSeconds: numeric }, ["enabled"]),
  markers: result({ supported: bool, unit: text, startBeats: numeric, endBeats: numeric, startSeconds: numeric, endSeconds: numeric }, ["supported"]),
  timeSignature: result({ numerator: { type: "integer", minimum: 1 }, denominator: { type: "integer", minimum: 1 } }),
  launchQuantization: object, launchMode: object, mute: object, editorGrid: object };
const clipNotes = versioned({ ...target, location: text, timeline: nullable(object), lengthBeats: numeric, notes }, ["notes"]);
const context = fields => versioned({ ...target, identityToken: text, supported: bool, status: text, reason: nullable(text), ...fields }, []);
const transport = { isPlaying: bool, isRecording: bool, tempo: numeric };

// Optional fields reflect capability-dependent native results. Known fields are
// checked when present; supported and unavailable observations remain distinct.
export const liveOutputContracts = {
  get_live_state: result({ stateVersion: version, setFingerprint: text, tempo: numeric, isPlaying: bool, filePath: nullable(text),
    bridgeVersion: text, capabilities: strings, serverIdentity: result(identity) }, ["stateVersion", "setFingerprint"]),
  list_tracks: versioned({ tracks: array(result({ id: text, name: text, type: text, mute: bool, solo: bool, armed: bool,
    volume: numeric, pan: numeric, isGroup: bool, isGrouped: bool, groupTrackId: nullable(text) }, ["id", "name", "type"])) }),
  list_scenes: versioned({ scenes: array(result({ id: text, name: text }, ["id", "name"])) }),
  list_clips: versioned({ trackId: text, clips: array(result({ id: text, name: nullable(text), hasClip: bool,
    durationUnit: nullable(text), lengthBeats: nullable(numeric), lengthSeconds: nullable(numeric),
    isPlaying: bool, isRecording: bool, isTriggered: bool }, ["id", "name"])) }, ["clips"]),
  list_arrangement_clips: versioned({ trackId: text, clips: array(result({ id: text, name: text, type: text, startBeats: numeric, endBeats: numeric, lengthBeats: numeric }, ["id", "name"])) }, ["clips"]),
  list_devices: versioned({ trackId: text, devices: array(result({ id: text, name: text, className: text }, ["id", "name"])) }, ["devices"]),
  list_device_parameters: versioned({ ...target, parameters: array(result({ id: text, name: text, value: numeric,
    min: numeric, max: numeric, enabled: bool, quantized: bool, displayValue: nullable(text) }, ["id", "name", "value"])) }, ["parameters"]),
  get_device_parameter_edit_context: versioned({ ...target, parameters: records, editContext: object }, ["parameters", "editContext"]),
  get_midi_clip_notes_extended: clipNotes,
  get_midi_clip_notes: versioned({ ...target, lengthBeats: numeric, notes: { type: "array" } }, ["notes"]),
  get_midi_note_selection: context({ notes, noteIds: integers, selectionToken: text, editContext: object }),
  get_midi_note_removal_context: context({ notes, clipTiming: object, editContext: object, removeSupported: bool }),
  get_midi_note_insertion_context: context({ notes, clipTiming: object, editContext: object, insertSupported: bool }),
  get_clip_timing: versioned(timing, []),
  get_audio_clip_state: versioned({ ...target, source: object, warping: bool, warpMarkers: object, gain: object,
    pitch: object, markers: object, loop: object }, ["trackId", "clipId"]),
  get_track_mixer: versioned(mixer, ["trackId", "volume"]),
  get_set_mixer: versioned({ master: result(mixer, []), returns: array(result({ id: text, ...mixer }, [])) }, ["master", "returns"]),
  get_track_routing: versioned({ trackId: text, input: route, output: route, monitoring: nullable(object) }, []),
  get_return_routing: context({ input: route, output: route, returnTrackId: text }),
  get_track_midi_routing: context({ input: route, output: route, monitoring: nullable(object) }),
  get_track_freeze_state: versioned({ trackId: text, freeze: result({ supported: bool, frozen: nullable(bool) }, ["supported"]) }),
  get_track_arm_context: context({ target: object, transport: object, armStates: records, inputStates: records, readyToChange: bool, reasons: strings }),
  get_song_musical_context: versioned({ timeSignature: result({ numerator: integer, denominator: integer }), key: object,
    quantization: object, groove: object, loop: object }, ["timeSignature"]),
  get_history_state: context({ canUndo: bool, canRedo: bool }),
  get_selection_context: context({ track: nullable(object), scene: nullable(object), device: nullable(object),
    detailClip: nullable(object), highlightedClipSlot: nullable(object) }),
  get_selected_parameter_context: context({ control: nullable(object), target: nullable(object), selectionToken: nullable(text), editContext: nullable(object), automationContext: nullable(object) }),
  get_parameter_automation_context: context({ parameterId: nullable(text), deviceName: nullable(text), controls: records, transport: object, frozen: nullable(bool) }),
  get_browser_preview_context: context({ item: nullable(object), root: nullable(text), path: nullable(strings), previewSupported: bool, stopSupported: bool, transport: object }),
  get_mixer_panning_context: context({ owner: object, mode: object, transport: object }),
  get_crossfader_context: versioned({ setFingerprint: text, position: object, tracks: records, assignmentChoices: records, transport: object, identityToken: text }),
  get_live_object_colors: context({ objects: records, selection: object }),
  get_device_hierarchy: versioned({ trackId: text, device: object }),
  get_device_sidechain_routing: versioned({ trackId: text, deviceId: text, device: object, sidechain: object }),
  get_device_activation_context: context({ device: object, editContext: object }),
  get_device_ab_context: context({ activeSlot: integer, canCopy: bool, isFrozen: bool, isPlaying: bool, parameters: records,
    parametersDigest: text, otherSlotContentsAvailable: bool, recording: object }),
  get_clip_parameter_envelope: versioned({ trackId: text, clipId: text, parameterId: text, parameter: object, exists: bool,
    samples: array(result({ time: numeric, value: numeric })) }),
  get_clip_mixer_envelope: context({ exists: bool, samples: array(result({ time: numeric, value: numeric })) }),
  get_transport_context: context({ ...transport, currentSongTime: numeric, loop: object, signature: object }),
  get_transport_recording_context: context({ arrangement: object, session: object, countingIn: bool }),
  get_session_midi_overdub_context: context({ ...transport, baseline: nullable(object), sessionRecord: bool, arrangementOverdub: bool,
    legacyOverdub: bool, isOverdubbing: bool, isRecording: bool, tracks: records, routing: object, midiRouting: object, timing: object }),
  get_midi_capture_context: context({ canCapture: bool, captureSupported: bool, tracks: records, transport: object }),
  list_arrangement_cue_points: versioned({ cuePoints: records }),
  get_take_lane_context: context({ takeLanes: records, lanes: records, source: object }),
  get_take_lane_audition_context: context({ lanes: records, source: object, ui: object }),
  get_scene_launch_context: context({ sceneId: text, scenes: records, tracks: records, transport: object }),
  get_simpler_sample_state: context({ sample: nullable(object), track: object, recording: object, parameters: records }),
  get_clip_groove_context: versioned({ trackId: text, clipId: text, source: object, timing: object, musicalContext: object }),
  get_track_signal_activity: context({ meters: object, controls: object, tracks: records }),
  get_rack_performance_context: context({ macros: records, variations: object, chains: records, device: object }),
  get_looper_performance_context: context({ controls: object, device: object, parameters: records }),
  get_beat_repeat_performance_context: context({ controls: object, device: object, parameters: records }),
  get_looper_export_context: context({ parameters: records, canExport: bool, loopLength: nullable(numeric), tempo: nullable(numeric), destination: object }),
  get_track_grouping_status: versioned({ groupingId: text, status: text, members: records, groupVerified: bool, inspectionRequired: bool }),
  get_track_ungrouping_status: versioned({ ungroupingId: text, status: text, members: records, ungroupVerified: bool, inspectionRequired: bool })
};

const handleResult = fields => context({ ...fields, status: text, reason: nullable(text), cleanupErrors: strings });
Object.assign(liveOutputContracts, {
  get_arrangement_take: handleResult({ takeId: text, takes: records, startBeats: numeric, endBeats: numeric, clips: records,
    recordingRequested: bool, recordingVerified: bool, performanceVerified: bool }),
  get_live_audio_capture: handleResult({ captureId: text, captures: records, file: nullable(object), fileUnchanged: nullable(bool),
    scope: text, beats: numeric, partialSourcePath: nullable(text) }),
  get_session_arrangement_recording: handleResult({ recordingId: text, recordings: records, clips: records }),
  get_instrument_comparison: handleResult({ comparisonId: text, comparisons: records, alternatives: records }),
  get_session_clip_hold: handleResult({ holdId: text, holds: records, mode: text, durationSeconds: numeric, elapsedSeconds: numeric,
    isPlaying: bool, isTriggered: bool, pressCallReturned: bool, releaseRequested: bool, releaseCallReturned: bool }),
  get_beat_repeat_fill: handleResult({ fillId: text, fills: records, finished: bool })
});
