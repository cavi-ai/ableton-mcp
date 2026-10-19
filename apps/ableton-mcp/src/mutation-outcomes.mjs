// Explicit registration makes new guarded tools declare their receipt semantics.
// Versioned receipts preserve the legacy operation-response/state-readback guarantee.
const versionedTools = [
  "set_session_clip_entry", "create_arrangement_audio_clip", "create_arrangement_midi_clip", "rename_arrangement_clip", "set_selected_parameter",
  "remove_midi_notes", "insert_midi_notes", "capture_session_scene", "copy_arrangement_clip_to_track", "set_browser_preview",
  "override_parameter_automation", "re_enable_parameter_automation", "set_mixer_panning", "set_crossfader_state", "return_tracks_to_arrangement",
  "hold_session_clip", "finish_session_clip_hold", "ungroup_tracks", "group_tracks", "set_live_object_colors",
  "show_live_object", "export_midi_clip", "bounce_track_in_place", "record_arrangement_take", "finish_arrangement_take",
  "copy_device_ab_slot", "select_device_ab_slot", "import_midi_file", "save_native_device_preset", "collect_project_media",
  "export_audio_track", "export_audio_mix", "audition_arrangement_passage", "recall_device_chain_snapshot", "recall_group_system_snapshot",
  "recall_track_state_snapshot", "recall_device_parameter_snapshot", "open_live_set", "save_live_set", "capture_live_audio",
  "finish_live_audio_capture", "prepare_instrument_comparison", "adopt_instrument_comparison", "select_instrument_comparison", "duplicate_midi_clip_variations",
  "undo", "redo", "set_transport_context", "set_session_midi_overdub", "record_session_arrangement",
  "finish_session_arrangement_recording", "capture_midi_session", "set_transport_recording_context", "set_groove", "set_song_musical_context",
  "create_arrangement_cue_point", "rename_arrangement_cue_point", "delete_arrangement_cue_point", "jump_to_arrangement_cue_point", "show_take_lanes",
  "select_take_lane_audition", "set_simpler_manual_slices", "set_simpler_sample_region", "load_simpler_sample", "create_track",
  "create_return_track", "create_scene", "rename_session_object", "duplicate_session_object", "delete_session_object",
  "create_scale_chord_progression_clip", "create_scale_bassline_clip", "create_scale_melody_clip", "create_drum_pattern_clip", "edit_drum_pattern_clip",
  "apply_drum_variation", "humanize_midi_notes", "apply_midi_velocity_curve", "apply_midi_gate_pattern", "apply_midi_probability_pattern",
  "apply_midi_ratchet_pattern", "apply_midi_strum_pattern", "apply_midi_chord_inversion", "apply_midi_drop_voicing", "apply_midi_chord_voice_leading",
  "apply_midi_chord_doubling", "apply_midi_chord_arpeggiation", "apply_midi_transposition", "apply_midi_diatonic_transposition", "apply_midi_diatonic_harmony",
  "apply_midi_scale_chord_remapping", "apply_midi_diatonic_chord_quality", "apply_midi_feel_template", "set_clip_timing", "set_midi_clip_markers",
  "set_audio_clip_state", "apply_monophonic_audio_tuning", "duplicate_clip", "delete_clip", "duplicate_clip_loop",
  "set_track_routing", "set_group_fold_state", "route_tracks_to_bus", "route_tracks_to_return_bus", "create_audio_clip",
  "move_arrangement_clip", "duplicate_arrangement_clip", "delete_arrangement_clip", "place_session_clip_in_arrangement", "move_device",
  "set_master_mixer", "set_return_mixer", "export_looper_clip", "load_factory_browser_item", "load_browser_item",
  "set_rack_chain_note_routing", "set_drum_pad_state", "rename_rack_chain", "set_rack_chain_mixer", "move_device_to_chain",
  "create_rack_chain", "adjust_rack_macro_count", "map_rack_macro_to_parameter", "set_rack_macro_mapping_edge", "rename_rack_macro",
  "store_rack_macro_variation", "recall_rack_macro_variation", "delete_rack_macro_variation", "randomize_rack_macros", "set_device_sidechain_routing",
  "crop_midi_clip", "crop_audio_clip", "reverse_audio_clip", "quantize_audio_clip", "set_device_active",
  "delete_device", "move_audio_warp_marker", "remove_audio_warp_marker", "add_audio_warp_marker", "set_device_parameters",
  "set_looper_state", "set_beat_repeat_enabled", "perform_beat_repeat_fill", "finish_beat_repeat_fill", "set_beat_repeat_grid",
  "set_beat_repeat_interval", "create_midi_clip", "set_clip_parameter_envelope", "set_midi_note_properties", "correct_midi_clip_to_scale",
  "transform_midi_notes", "panic", "transport_play", "transport_stop", "set_tempo",
  "set_track_mixer", "launch_scene", "launch_clip", "stop_clip", "set_clip_slot_stop_button",
  "arm_track", "set_scene_launch_quantization", "set_scene_musical_context", "create_groove", "set_track_midi_routing",
  "set_track_freeze_state", "set_bulk_track_mixer", "set_track_volume_db", "set_track_send_db", "create_clip_parameter_envelope",
  "create_clip_mixer_envelope", "set_device_parameter_display", "stop_all_clips",
];

export const mutationOutcomeContracts = Object.fromEntries(versionedTools.map(name => [name, ["stateVersion"]]));
const declare = (fields, names) => { for (const name of names.split(" ")) mutationOutcomeContracts[name] = fields; };
declare(["verified"], "set_session_clip_entry set_selected_parameter override_parameter_automation re_enable_parameter_automation set_mixer_panning set_crossfader_state rename_arrangement_clip rename_session_object set_simpler_manual_slices set_simpler_sample_region load_simpler_sample set_device_active arm_track set_track_volume_db set_track_send_db set_device_parameter_display create_arrangement_midi_clip create_clip_parameter_envelope create_clip_mixer_envelope set_clip_parameter_envelope");
declare(["copyVerified"], "duplicate_clip duplicate_session_object duplicate_arrangement_clip copy_arrangement_clip_to_track copy_device_ab_slot");
declare(["deletionVerified"], "delete_clip delete_arrangement_clip delete_session_object");
declare(["requestedChangesVerified"], "set_track_mixer set_bulk_track_mixer set_master_mixer set_return_mixer set_track_routing");
declare(["editVerified"], "set_midi_note_properties");
declare(["removalVerified"], "remove_midi_notes");
declare(["insertionVerified"], "insert_midi_notes");
declare(["markersVerified"], "set_midi_clip_markers");
declare(["captureVerified"], "capture_session_scene capture_midi_session");
declare(["moveVerified"], "move_arrangement_clip");
declare(["importVerified"], "create_arrangement_audio_clip import_midi_file");
declare(["slotVerified"], "select_device_ab_slot");
declare(["writeCompleted"], "set_live_object_colors");
declare(["showVerified"], "show_live_object");
declare(["previewVerified"], "set_browser_preview");
declare(["requestedChangeVerified"], "set_device_sidechain_routing");
declare(["placementVerified"], "place_session_clip_in_arrangement");
declare(["clipCreatedVerified"], "export_looper_clip");
declare(["groupVerified"], "group_tracks");
declare(["ungroupVerified"], "ungroup_tracks");
declare(["freezeVerified"], "set_track_freeze_state");
declare(["bounceVerified"], "bounce_track_in_place");
declare(["reverseVerified"], "reverse_audio_clip");
declare(["exportVerified"], "export_midi_clip export_audio_mix export_audio_track");
declare(["presetSaveVerified"], "save_native_device_preset");
declare(["sampleCollectionVerified"], "collect_project_media");
declare(["opened"], "open_live_set");
declare(["saved"], "save_live_set");
for (const fields of Object.values(mutationOutcomeContracts)) Object.freeze(fields);
Object.freeze(mutationOutcomeContracts);

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const at = (value, path) => path.split(".").reduce((item, key) => record(item) ? item[key] : undefined, value);
const layers = value => [value, value?.observed].filter(record);
const has = (value, key, expected) => layers(value).some(item => at(item, key) === expected);
const receipt = (status, reason, evidence = []) => ({ schemaVersion: 1, status, reason, evidence });
const activeStates = new Set(["active", "starting", "recording", "stopping", "finalizing", "file_ready"]);
const failedStates = new Set(["failed", "ownership_lost", "start_failed", "start_unverified", "cleanup_failed", "unverified", "partial"]);
const performanceStarts = new Set(["hold_session_clip", "perform_beat_repeat_fill", "record_arrangement_take", "record_session_arrangement", "capture_live_audio"]);

function requiredEvidence(name, args) {
  if (name === "transform_midi_notes") {
    if (args.operation?.type === "reverseTime") return ["reversalVerified"];
    if (args.operation?.type === "scaleTime") return ["verification.confirmed"];
  }
  if (name === "set_clip_timing") {
    if (args.grooveId === null) return ["removalVerified"];
    if (args.loop !== undefined) return ["requestedChangesVerified"];
  }
  if (name === "set_audio_clip_state" && ["startMarkerBeats", "endMarkerBeats", "startMarkerSeconds", "endMarkerSeconds"].some(key => args[key] !== undefined))
    return ["verification.markerBoundsConfirmed"];
  if (name === "set_transport_context" && args.countInDuration !== undefined) return ["transportVerified"];
  if (name === "set_transport_recording_context")
    return ["verification.controlsConfirmed"];
  if (name === "hold_session_clip") return ["pressCallReturned", "releaseCallReturned"];
  if (name === "perform_beat_repeat_fill") return ["releaseVerified", "repeatOffObserved"];
  if (name === "finish_session_clip_hold") return ["handleReleased", "releaseCallReturned"];
  if (name === "finish_beat_repeat_fill") return ["handleReleased", "releaseVerified", "repeatOffObserved"];
  if (name === "finish_arrangement_take" || name === "finish_session_arrangement_recording") return ["released"];
  if (name === "record_arrangement_take") return ["rangeCovered"];
  if (name === "record_session_arrangement") return ["stopVerified", "capturedClipsAvailable", "originalClipMetadataPreserved"];
  if (name === "capture_live_audio" || name === "finish_live_audio_capture") return ["status=complete", "fileUnchanged"];
  return mutationOutcomeContracts[name];
}

// Read only explicit execution evidence. False audible/hidden-state/equivalence
// limits are deliberately not treated as failed execution checks.
export function classifyMutationOutcome(name, args, value) {
  if (!Object.hasOwn(mutationOutcomeContracts, name)) return receipt("outcome_unknown", "undeclared_tool");
  if (!record(value) || value.dryRun !== false)
    return receipt("outcome_unknown", "missing_receipt");
  if (has(value, "inspectionRequired", true)) return receipt("outcome_unknown", "inspection_required");
  if (layers(value).some(item => ["verified", "targetRetained", "contextPreserved", "writeCompleted", "showVerified"].some(key => item[key] === false) ||
      item.writeRequested === true && item.nativeReturned === false)) return receipt("outcome_unknown", "native_failure");
  if (has(value, "pendingUserAction", true)) return receipt("pending_user_action", "user_action_required");
  if (Object.hasOwn(value, "observed") && !record(value.observed)) return receipt("outcome_unknown", "missing_receipt");
  if (layers(value).some(item => ["error", "observationError", "verificationError", "inspectionError", "controlError", "startError"].some(key => Boolean(item[key])) ||
      Array.isArray(item.cleanupErrors) && item.cleanupErrors.length || failedStates.has(item.status)))
    return receipt("outcome_unknown", "native_failure");
  if (performanceStarts.has(name) && layers(value).some(item => ["interrupted", "superseded", "cancelled"].includes(item.status)))
    return receipt("outcome_unknown", "interrupted_performance");
  if (layers(value).some(item => activeStates.has(item.status)) &&
      (performanceStarts.has(name) || name === "finish_live_audio_capture"))
    return receipt("pending_postconditions", "operation_in_progress");
  if (["launch_scene", "launch_clip"].includes(name) && (has(value, "playbackVerified", false) ||
      has(value, "recordingRequested", true) && has(value, "recordingVerified", false)))
    return receipt("pending_postconditions", "request_only");
  if (has(value, "saved", false) || has(value, "opened", false)) return receipt("postconditions_failed", "operation_not_completed");
  const fields = requiredEvidence(name, args), evidence = [];
  for (const field of fields) {
    const [path, expected] = field.split("=");
    const candidates = layers(value).map(item => at(item, path)).filter(item => item !== undefined);
    const matches = path === "stateVersion" ? item => Number.isSafeInteger(item) && item >= args.expectedStateVersion
      : expected === undefined ? item => item === true : item => item === expected;
    if (!candidates.length || !candidates.every(matches)) return receipt("outcome_unknown", "unverified_execution", [field]);
    evidence.push(field);
  }
  return receipt("applied", "execution_receipt", evidence);
}

export function withMutationOutcome(name, args, value) {
  if (args.dryRun !== false || !Number.isInteger(args.expectedStateVersion)) return value;
  return { ...value, operationOutcome: classifyMutationOutcome(name, args, value) };
}
