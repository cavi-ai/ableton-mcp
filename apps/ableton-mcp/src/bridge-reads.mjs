const emptyArguments = Object.freeze({
  "get_live_state": true,
  "get_selection_context": true,
  "get_transport_context": true,
  "get_rack_performance_context": false,
  "get_looper_performance_context": false,
  "get_beat_repeat_performance_context": false,
  "get_history_state": true,
  "get_clip_groove_context": false,
  "get_transport_recording_context": true,
  "list_arrangement_cue_points": true,
  "list_tracks": true,
  "list_scenes": true,
  "list_clips": false,
  "list_arrangement_clips": false,
  "get_midi_clip_notes": false,
  "get_midi_clip_notes_extended": false,
  "get_midi_note_selection": false,
  "get_track_mixer": false,
  "get_track_signal_activity": false,
  "get_track_routing": false,
  "get_track_arm_context": false,
  "get_set_mixer": true,
  "list_browser_roots": true,
  "get_clip_parameter_envelope": false,
  "get_clip_mixer_envelope": false,
  "get_clip_timing": false,
  "get_audio_clip_state": false,
  "get_device_sidechain_routing": false,
  "list_devices": false,
  "get_device_hierarchy": false,
  "get_midi_capture_context": true,
  "get_track_midi_routing": false,
  "get_track_freeze_state": false,
  "list_device_parameters": false
});

export const bridgeReadNames = Object.freeze(Object.keys(emptyArguments));
export const isBridgeRead = name => Object.hasOwn(emptyArguments, name);

export function readBridgeContext(bridge, name, args) {
  if (!isBridgeRead(name)) throw new Error(`unknown bridge read: ${name}`);
  return bridge.request(name, emptyArguments[name] ? {} : args);
}
