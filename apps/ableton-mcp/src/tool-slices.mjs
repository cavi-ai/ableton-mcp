// Job slices for one functional MCP process. A session advertises the union of
// the slices it was given.

export const toolSlices = {
  observe: [
    "get_live_state", "get_selection_context", "get_session_orientation", "get_transport_context",
    "get_song_musical_context", "get_song_grid_reference", "get_live_scale_reference", "list_live_scales",
    "list_tracks", "list_scenes", "list_clips", "get_history_state"
  ],
  transport: [
    "transport_play", "transport_stop", "panic", "arm_track", "get_track_arm_context",
    "launch_clip", "launch_scene", "stop_clip", "stop_all_clips", "set_tempo", "set_transport_context",
    "get_transport_recording_context", "set_transport_recording_context", "get_scene_launch_context",
    "set_scene_launch_quantization"
  ],
  session: [
    "create_track", "create_scene", "rename_session_object", "duplicate_session_object", "delete_session_object",
    "get_live_object_colors", "set_live_object_colors", "duplicate_clip", "delete_clip", "duplicate_clip_loop",
    "set_clip_slot_stop_button", "set_scene_musical_context", "capture_session_scene", "show_live_object",
    "set_session_clip_entry", "undo", "redo"
  ],
  midi: [
    "get_midi_clip_notes", "get_midi_clip_notes_extended", "get_midi_note_selection",
    "get_midi_note_insertion_context", "get_midi_note_removal_context", "insert_midi_notes", "remove_midi_notes",
    "set_midi_note_properties", "transform_midi_notes", "correct_midi_clip_to_scale", "crop_midi_clip",
    "set_midi_clip_markers", "get_clip_timing", "set_clip_timing", "analyze_midi_clip_chords", "analyze_midi_clip_scale",
    "analyze_midi_parts", "create_midi_clip", "duplicate_midi_clip_variations", "set_song_musical_context"
  ],
  voicing: [
    "plan_scale_chord_progression", "plan_scale_bassline", "plan_scale_melody",
    "create_scale_chord_progression_clip", "create_scale_bassline_clip", "create_scale_melody_clip",
    "plan_midi_chord_arpeggiation", "apply_midi_chord_arpeggiation", "plan_midi_chord_doubling", "apply_midi_chord_doubling",
    "plan_midi_chord_inversion", "apply_midi_chord_inversion", "plan_midi_chord_voice_leading", "apply_midi_chord_voice_leading",
    "plan_midi_diatonic_chord_quality", "apply_midi_diatonic_chord_quality", "plan_midi_diatonic_harmony", "apply_midi_diatonic_harmony",
    "plan_midi_diatonic_transposition", "apply_midi_diatonic_transposition", "plan_midi_drop_voicing", "apply_midi_drop_voicing",
    "plan_midi_scale_chord_remapping", "apply_midi_scale_chord_remapping", "plan_midi_transposition", "apply_midi_transposition"
  ],
  drums: [
    "plan_drum_pattern", "plan_drum_pattern_edit", "plan_drum_variation", "create_drum_pattern_clip",
    "edit_drum_pattern_clip", "apply_drum_variation", "set_drum_pad_state"
  ],
  feel: [
    "analyze_midi_feel", "get_clip_groove_context", "inspect_clip_groove_postconditions", "create_groove", "set_groove",
    "save_midi_feel_template", "load_midi_feel_template", "apply_midi_feel_template", "plan_midi_humanization",
    "humanize_midi_notes", "plan_midi_velocity_curve", "apply_midi_velocity_curve", "plan_midi_gate_pattern",
    "apply_midi_gate_pattern", "plan_midi_probability_pattern", "apply_midi_probability_pattern", "plan_midi_ratchet_pattern",
    "apply_midi_ratchet_pattern", "plan_midi_strum_pattern", "apply_midi_strum_pattern"
  ],
  arrangement: [
    "analyze_arrangement_section", "plan_arrangement_repeat", "audition_arrangement_passage", "return_tracks_to_arrangement",
    "list_arrangement_clips", "list_arrangement_cue_points", "create_arrangement_cue_point", "rename_arrangement_cue_point",
    "delete_arrangement_cue_point", "jump_to_arrangement_cue_point", "place_session_clip_in_arrangement",
    "delete_arrangement_clip", "move_arrangement_clip", "duplicate_arrangement_clip", "copy_arrangement_clip_to_track",
    "rename_arrangement_clip", "create_arrangement_midi_clip"
  ],
  mixer: [
    "get_track_mixer", "set_track_mixer", "set_bulk_track_mixer", "set_track_volume_db", "set_track_send_db",
    "get_set_mixer", "set_return_mixer", "set_master_mixer", "get_mixer_panning_context", "set_mixer_panning",
    "get_track_signal_activity", "get_crossfader_context", "set_crossfader_state"
  ],
  routing: [
    "get_track_routing", "set_track_routing", "get_return_routing", "route_tracks_to_bus", "route_tracks_to_return_bus",
    "get_device_sidechain_routing", "set_device_sidechain_routing", "get_track_midi_routing", "set_track_midi_routing",
    "group_tracks", "ungroup_tracks", "get_track_grouping_status", "get_track_ungrouping_status", "set_group_fold_state",
    "create_return_track"
  ],
  devices: [
    "list_browser_roots", "get_browser_items", "search_browser_items", "search_browser_roots", "load_browser_item",
    "get_factory_browser_items", "load_factory_browser_item", "list_devices", "list_device_parameters",
    "set_device_parameters", "set_device_parameter_display", "set_device_active", "delete_device", "move_device",
    "get_factory_device_context", "get_factory_coverage", "list_factory_device_profiles", "get_plugin_integration_context",
    "get_device_activation_context", "get_device_ab_context", "copy_device_ab_slot", "select_device_ab_slot",
    "get_browser_preview_context", "set_browser_preview", "get_selected_parameter_context", "set_selected_parameter",
    "list_producer_chain_blueprints", "get_producer_chain_blueprint", "inspect_producer_chain", "inspect_producer_bus", "inspect_producer_return_bus"
  ],
  compare: [
    "get_instrument_comparison", "prepare_instrument_comparison", "adopt_instrument_comparison", "select_instrument_comparison"
  ],
  racks: [
    "get_device_hierarchy", "create_rack_chain", "adjust_rack_macro_count", "map_rack_macro_to_parameter",
    "set_rack_macro_mapping_edge", "rename_rack_macro", "store_rack_macro_variation", "recall_rack_macro_variation",
    "delete_rack_macro_variation", "randomize_rack_macros", "set_rack_chain_mixer", "rename_rack_chain",
    "set_rack_chain_note_routing", "move_device_to_chain", "get_rack_performance_context"
  ],
  envelopes: [
    "get_automation_capabilities", "get_clip_parameter_envelope", "get_clip_mixer_envelope", "create_clip_parameter_envelope",
    "create_clip_mixer_envelope", "set_clip_parameter_envelope", "plan_grid_envelope_pattern", "get_parameter_automation_context",
    "re_enable_parameter_automation", "override_parameter_automation"
  ],
  audio: [
    "get_audio_clip_state", "set_audio_clip_state", "get_audio_source_beat_times", "propose_audio_transient_warp",
    "analyze_audio_file", "analyze_audio_clip", "compare_audio_reference", "apply_monophonic_audio_tuning",
    "move_audio_warp_marker", "remove_audio_warp_marker", "add_audio_warp_marker", "quantize_audio_clip", "crop_audio_clip",
    "reverse_audio_clip", "plan_audio_midi_sketch", "get_simpler_sample_state", "load_simpler_sample",
    "set_simpler_sample_region", "set_simpler_manual_slices"
  ],
  recording: [
    "capture_live_audio", "get_live_audio_capture", "finish_live_audio_capture", "capture_midi_session",
    "get_midi_capture_context", "record_arrangement_take", "get_arrangement_take", "finish_arrangement_take",
    "record_session_arrangement", "get_session_arrangement_recording", "finish_session_arrangement_recording",
    "get_session_midi_overdub_context", "set_session_midi_overdub", "hold_session_clip", "get_session_clip_hold",
    "finish_session_clip_hold", "get_take_lane_context", "get_take_lane_audition_context", "show_take_lanes",
    "select_take_lane_audition", "get_looper_performance_context", "get_looper_export_context", "export_looper_clip",
    "set_looper_state", "get_beat_repeat_performance_context", "get_beat_repeat_fill", "perform_beat_repeat_fill",
    "finish_beat_repeat_fill", "set_beat_repeat_enabled", "set_beat_repeat_grid", "set_beat_repeat_interval"
  ],
  files: [
    "open_live_set", "save_live_set", "export_audio_mix", "export_audio_track", "export_midi_clip", "bounce_track_in_place",
    "save_native_device_preset", "get_project_media", "collect_project_media", "import_midi_file", "create_audio_clip",
    "answer_live_recovery_prompt", "get_live_dialog_state", "cancel_live_export_dialog", "raise_live",
    "create_arrangement_audio_clip", "get_track_freeze_state", "set_track_freeze_state"
  ],
  library: [
    "search_presets", "get_preset", "get_preset_metadata", "set_preset_metadata", "get_browser_item_metadata",
    "set_browser_item_metadata", "search_browser_item_metadata", "list_local_splice_roots", "browse_local_splice_directory",
    "search_local_splice_samples", "get_nks_generation_status", "get_nks_generation_job", "enqueue_nks_generation_jobs",
    "claim_nks_generation_job", "heartbeat_nks_generation_job", "fail_nks_generation_job", "complete_nks_generation_job",
    "list_saved_snapshots", "capture_device_parameter_snapshot", "capture_device_chain_snapshot", "save_device_chain_snapshot",
    "load_device_chain_snapshot", "recall_device_chain_snapshot", "recall_device_parameter_snapshot",
    "capture_track_state_snapshot", "save_track_state_snapshot", "load_track_state_snapshot", "recall_track_state_snapshot",
    "capture_group_system_snapshot", "save_group_system_snapshot", "load_group_system_snapshot", "plan_group_system_recall",
    "recall_group_system_snapshot"
  ]
};

export const sliceResourceUris = {
  observe: [
    "ableton://live/status", "ableton://live/transport", "ableton://live/history", "ableton://set/history",
    "ableton://set/musical-context", "ableton://set/tracks", "ableton://set/scenes", "ableton://track/{track_id}/clips"
  ],
  transport: [],
  session: [],
  midi: [
    "ableton://track/{track_id}/clip/{clip_id}/notes", "ableton://track/{track_id}/clip/{clip_id}/timing"
  ],
  voicing: [],
  drums: [],
  feel: [],
  arrangement: ["ableton://track/{track_id}/arrangement-clips"],
  mixer: ["ableton://set/mixer", "ableton://track/{track_id}/mixer"],
  routing: ["ableton://track/{track_id}/routing", "ableton://track/{track_id}/midi-routing"],
  devices: ["ableton://track/{track_id}/devices", "ableton://device/{device_id}/parameters"],
  compare: [],
  racks: [],
  envelopes: [],
  audio: ["ableton://track/{track_id}/clip/{clip_id}/audio"],
  recording: [],
  files: ["ableton://track/{track_id}/freeze"],
  library: ["nks://catalog/products", "nks://catalog/presets/{preset_id}", "nks://catalog/artwork/{artwork_id}"]
};

export function toolsForSlices(names) {
  const selected = new Set();
  for (const name of names) for (const tool of toolSlices[name]) selected.add(tool);
  return selected;
}

export function resourceUrisForSlices(names) {
  const uris = [];
  for (const name of names) uris.push(...sliceResourceUris[name]);
  return uris;
}

export function normalizeSlices(value) {
  const names = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((part) => part.trim()) : null;
  if (!names || names.length === 0 || names.some((name) => typeof name !== "string" || !name))
    throw new Error("ABLETON_MCP_TOOL_SLICES requires at least one slice");
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`duplicate tool slice: ${name}`);
    if (!Object.hasOwn(toolSlices, name)) throw new Error(`unknown tool slice: ${name}`);
    seen.add(name);
  }
  return names;
}

// Exact sessions name functional tools only.
export function normalizeToolNames(value) {
  const names = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((part) => part.trim()) : null;
  if (!names || names.length === 0 || names.some((name) => typeof name !== "string" || !name))
    throw new Error("ABLETON_MCP_TOOLS requires at least one tool");
  const functional = new Set(Object.values(toolSlices).flat());
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`duplicate tool: ${name}`);
    if (!functional.has(name)) throw new Error(`unknown functional tool: ${name}`);
    seen.add(name);
  }
  return names;
}

export function sessionSelection(env = {}) {
  const profile = env.ABLETON_MCP_TOOL_PROFILE;
  const slices = env.ABLETON_MCP_TOOL_SLICES;
  const tools = env.ABLETON_MCP_TOOLS;
  const hasProfile = profile !== undefined && profile !== "";
  const hasSlices = slices !== undefined;
  const hasTools = tools !== undefined;
  const selectors = [hasProfile && "ABLETON_MCP_TOOL_PROFILE", hasSlices && "ABLETON_MCP_TOOL_SLICES", hasTools && "ABLETON_MCP_TOOLS"].filter(Boolean);
  if (selectors.length > 1) throw new Error(`${selectors.join(" and ")} are mutually exclusive`);
  if (hasTools) return { toolNames: normalizeToolNames(tools) };
  if (hasSlices) return { toolSlices: normalizeSlices(slices) };
  if (hasProfile) return { toolProfile: profile };
  return { toolSlices: ["observe"] };
}

export function listSliceCatalog() {
  return Object.entries(toolSlices).map(([name, tools]) => ({
    name, toolCount: tools.length, tools, resources: sliceResourceUris[name]
  }));
}

export function resourceVisible(uri, uris) {
  for (const candidate of uris) {
    if (candidate === uri) return true;
    if (!candidate.includes("{")) continue;
    const pattern = `^${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`;
    if (new RegExp(pattern).test(uri)) return true;
  }
  return false;
}
