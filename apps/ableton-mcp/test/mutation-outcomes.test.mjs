import test from "node:test";
import assert from "node:assert/strict";
import { classifyMutationOutcome, mutationOutcomeContracts, withMutationOutcome } from "../src/mutation-outcomes.mjs";
import { toolContracts } from "../src/tool-contracts.mjs";

const args = { expectedStateVersion: 1, dryRun: false };
const outcome = (name, observed, options = {}) => classifyMutationOutcome(name, { ...args, ...options }, { dryRun: false, observed });

test("every guarded native tool declares a mutation receipt policy", () => {
  const names = Object.keys(toolContracts).filter(name => !["apply_production_operation", "advance_production_session"].includes(name) &&
    toolContracts[name].inputSchema.properties.dryRun && toolContracts[name].inputSchema.properties.expectedStateVersion);
  assert.deepEqual(Object.keys(mutationOutcomeContracts).sort(), names.sort());
});

for (const [name, evidence] of [
  ["capture_session_scene", "captureVerified"], ["capture_midi_session", "captureVerified"],
  ["duplicate_clip", "copyVerified"], ["duplicate_session_object", "copyVerified"],
  ["copy_arrangement_clip_to_track", "copyVerified"], ["delete_clip", "deletionVerified"],
  ["insert_midi_notes", "insertionVerified"], ["remove_midi_notes", "removalVerified"],
  ["set_midi_note_properties", "editVerified"], ["set_midi_clip_markers", "markersVerified"],
  ["set_device_active", "verified"], ["set_device_sidechain_routing", "requestedChangeVerified"],
  ["set_track_mixer", "requestedChangesVerified"], ["move_arrangement_clip", "moveVerified"],
  ["create_arrangement_audio_clip", "importVerified"], ["create_clip_parameter_envelope", "verified"],
  ["set_live_object_colors", "writeCompleted"], ["show_live_object", "showVerified"],
  ["group_tracks", "groupVerified"], ["ungroup_tracks", "ungroupVerified"],
  ["set_track_freeze_state", "freezeVerified"], ["bounce_track_in_place", "bounceVerified"],
  ["reverse_audio_clip", "reverseVerified"], ["export_midi_clip", "exportVerified"],
  ["import_midi_file", "importVerified"], ["export_looper_clip", "clipCreatedVerified"],
  ["save_native_device_preset", "presetSaveVerified"], ["collect_project_media", "sampleCollectionVerified"]
]) test(`${name} requires its explicit native execution evidence`, () => {
  for (const field of [undefined, null, false, "true"]) {
    assert.equal(outcome(name, { stateVersion: 2, [evidence]: field }).status, "outcome_unknown");
    assert.equal(classifyMutationOutcome(name, args, { dryRun: false, stateVersion: 2, [evidence]: field }).status, "outcome_unknown");
  }
  const receipt = { stateVersion: 2, [evidence]: true, audibleOutputVerified: false, hiddenExpressionVerified: false,
    completePerformanceEquivalenceVerified: false, materialPreservationVerified: false };
  assert.equal(outcome(name, receipt).status, "applied");
  assert.equal(outcome(name, { ...receipt, error: "partial native operation" }).status, "outcome_unknown");
});

test("unregistered tools and missing or contradictory receipts cannot claim execution", () => {
  assert.equal(outcome("new_native_tool", { stateVersion: 2, verified: true }).status, "outcome_unknown");
  for (const value of [null, {}, { dryRun: true }, { dryRun: false }, { dryRun: false, observed: null }])
    assert.equal(classifyMutationOutcome("set_tempo", args, value).status, "outcome_unknown");
  assert.equal(outcome("set_tempo", { stateVersion: 0 }).status, "outcome_unknown");
  assert.equal(outcome("set_tempo", { stateVersion: 2 }).status, "applied");
  assert.equal(classifyMutationOutcome("capture_session_scene", args, { dryRun: false, captureVerified: false,
    operationOutcome: { schemaVersion: 1, status: "applied" } }).status, "outcome_unknown");
  assert.equal(classifyMutationOutcome("duplicate_clip", args, { dryRun: false, copyVerified: false,
    observed: { copyVerified: true } }).status, "outcome_unknown");
});

test("preview plans and reads retain their original result and do not gain execution claims", () => {
  const plan = { dryRun: true, confirmation: { token: "review" } };
  assert.equal(withMutationOutcome("set_tempo", {}, plan), plan);
  const read = { stateVersion: 1 };
  assert.equal(withMutationOutcome("get_live_state", {}, read), read);
});

test("pending user actions and request-only receipts remain incomplete", () => {
  assert.equal(classifyMutationOutcome("export_midi_clip", args, { dryRun: false, observed: null, pendingUserAction: true }).status, "pending_user_action");
  assert.equal(outcome("launch_scene", { stateVersion: 2, launchRequested: true, playbackVerified: false }).status, "pending_postconditions");
  assert.equal(outcome("launch_clip", { stateVersion: 2, recordingRequested: true, recordingVerified: false }).status, "pending_postconditions");
  assert.equal(classifyMutationOutcome("export_audio_mix", args, { dryRun: false, artifactVerified: true,
    exportVerified: false, renderCompletion: "unconfirmed" }).status, "outcome_unknown");
});

test("active recordings and performance handles do not claim completed work", () => {
  for (const name of ["hold_session_clip", "perform_beat_repeat_fill", "record_arrangement_take", "record_session_arrangement", "capture_live_audio"])
    assert.equal(outcome(name, { stateVersion: 2, status: "recording", recordingVerified: true }).status, "pending_postconditions");
  assert.equal(outcome("record_arrangement_take", { stateVersion: 2, status: "stopped", rangeCovered: true, recordingRequested: true, recordingVerified: false, performanceVerified: false, cleanupErrors: [] }).status, "applied");
  assert.equal(outcome("record_arrangement_take", { stateVersion: 2, status: "stopped", rangeCovered: true, cleanupErrors: ["ownership lost"] }).status, "outcome_unknown");
  assert.equal(outcome("finish_session_clip_hold", { status: "cancelled", handleReleased: true, releaseCallReturned: true, buttonStateVerified: false, cleanupErrors: [] }).status, "applied");
  assert.equal(outcome("finish_beat_repeat_fill", { status: "cleanup_failed", handleReleased: true, releaseVerified: false }).status, "outcome_unknown");
  assert.equal(outcome("finish_arrangement_take", { status: "stopped", released: false }).status, "outcome_unknown");
  assert.equal(outcome("finish_arrangement_take", { status: "cancelled", released: true, performanceVerified: false }).status, "applied");
  assert.equal(outcome("finish_arrangement_take", { stateVersion: 2, status: "stopped", released: true, rangeCovered: true,
    recordingRequested: true, recordingVerified: false, cleanupErrors: [] }).status, "applied");
  assert.equal(outcome("capture_live_audio", { status: "complete", fileUnchanged: true, cleanupErrors: [] }).status, "applied");
  assert.equal(outcome("capture_live_audio", { status: "partial", fileUnchanged: true }).status, "outcome_unknown");
});

test("conditional mutation variants require their own execution evidence", () => {
  for (const [name, options, receipt] of [
    ["transform_midi_notes", { operation: { type: "reverseTime" } }, { reversalVerified: false }],
    ["transform_midi_notes", { operation: { type: "scaleTime" } }, { verification: { confirmed: false } }],
    ["set_clip_timing", { grooveId: null }, { removalVerified: false }],
    ["set_clip_timing", { loop: { enabled: true } }, { requestedChangesVerified: false }],
    ["set_audio_clip_state", { startMarkerBeats: 1 }, { verification: { markerBoundsConfirmed: false } }],
    ["set_audio_clip_state", { endMarkerSeconds: 3 }, {}],
    ["set_transport_context", { countInDuration: "one_bar" }, { transportVerified: false }],
    ["set_transport_recording_context", { loop: { enabled: true } }, { verification: { controlsConfirmed: false } }]
  ]) assert.equal(outcome(name, { stateVersion: 2, ...receipt }, options).status, "outcome_unknown");
});

test("interrupted performance starts differ from explicit successful cleanup", () => {
  const interrupted = { stateVersion: 2, status: "interrupted", pressCallReturned: true, releaseCallReturned: true,
    handleReleased: true, cleanupErrors: [] };
  assert.equal(outcome("hold_session_clip", interrupted).status, "outcome_unknown");
  assert.equal(outcome("finish_session_clip_hold", interrupted).status, "applied");
  assert.equal(outcome("perform_beat_repeat_fill", { stateVersion: 2, status: "superseded", releaseVerified: true, repeatOffObserved: true }).status, "outcome_unknown");
  assert.equal(outcome("record_arrangement_take", { stateVersion: 2, status: "cancelled", rangeCovered: true }).status, "outcome_unknown");
});
