import test from "node:test";
import assert from "node:assert/strict";
import { toolContracts } from "../src/tool-contracts.mjs";
import { validateToolArguments, validateToolResult } from "../src/tool-validation.mjs";
import { buildSongGridReference } from "../src/song-grid-reference.mjs";

test("every public tool rejects an empty success result", () => {
  const accepted = [];
  for (const name of Object.keys(toolContracts)) {
    try { validateToolResult(name, {}); accepted.push(name); }
    catch (error) { assert.match(error.message, /^invalid tool result:/, name); }
  }
  assert.deepEqual(accepted, [], `missing result contracts: ${accepted.join(", ")}`);
});

test("every public argument schema compiles under strict validation", () => {
  for (const name of Object.keys(toolContracts)) {
    try { validateToolArguments(name, {}); }
    catch (error) { assert.equal(error.code, -32602, name); }
  }
});

test("MIDI result contracts validate the values used to propose and verify edits", () => {
  const note = { noteId: 1, pitch: 60, start: 0, duration: 1, velocity: 90, mute: false,
    probability: 1, velocityDeviation: 0, releaseVelocity: 0 };
  const result = { stateVersion: 1, trackId: "track-0", clipId: "track-0:clip-0", lengthBeats: 4, notes: [note] };
  assert.equal(validateToolResult("get_midi_clip_notes_extended", result), result);
  for (const changes of [{ noteId: "1" }, { pitch: 128 }, { start: "0" }, { duration: "1" },
    { velocity: 128 }, { mute: "false" }, { probability: 2 }])
    assert.throws(() => validateToolResult("get_midi_clip_notes_extended", { ...result, notes: [{ ...note, ...changes }] }), /invalid tool result/);
  assert.throws(() => validateToolResult("get_midi_clip_notes_extended", { ...result, notes: [{}] }), /invalid tool result/);
});

test("mixer, timing and routing contracts reject malformed decision fields", () => {
  const invalid = [
    ["get_track_mixer", { stateVersion: 1, trackId: "track-0", volume: { value: 0.5, decibels: "-12" } }],
    ["get_clip_timing", { stateVersion: 1, loop: { enabled: "true" } }],
    ["get_track_routing", { stateVersion: 1, trackId: "track-0", input: { availableTypes: "all" } }]
  ];
  for (const [name, value] of invalid) assert.throws(() => validateToolResult(name, value), /invalid tool result/, name);
});

test("empty, unsupported and pending native observations remain valid", () => {
  const cases = [
    ["get_selected_parameter_context", { stateVersion: 1, status: "none", selectionToken: null,
      target: null, control: null, automationContext: null, editContext: null }],
    ["list_clips", { stateVersion: 1, clips: [{ id: "track-0:clip-0", name: null, hasClip: false,
      durationUnit: null, lengthBeats: null, lengthSeconds: null, isPlaying: false }] }],
    ["get_track_freeze_state", { stateVersion: 1, trackId: "track-0", freeze: { supported: false, frozen: null } }],
    ["get_live_audio_capture", { stateVersion: 1, captureId: "capture", status: "pending", reason: null,
      clipId: null, file: null, fileUnchanged: null, cleanupErrors: [] }],
    ["get_clip_timing", { stateVersion: 1, loop: { enabled: true, unit: "seconds", startSeconds: 0, endSeconds: 2 },
      markers: { supported: false } }],
    ["get_browser_preview_context", { stateVersion: 1, root: null, path: null, item: null,
      previewSupported: false, stopSupported: true }],
    ["claim_nks_generation_job", { job: null, preset: null }]
  ];
  for (const [name, value] of cases) assert.equal(validateToolResult(name, value), value, name);
});

test("local writes retain uncertain outcomes when their response is malformed", () => {
  for (const [name, args] of [["set_preset_metadata", { dryRun: false }], ["heartbeat_nks_generation_job", {}]]) {
    assert.throws(() => validateToolResult(name, {}, args), error =>
      error.code === "INVALID_TOOL_RESULT" && error.outcome === "unknown", name);
  }
});

test("odd-meter grids and active overdubs retain unavailable baselines", () => {
  const grid = { stateVersion: 1, setFingerprint: "set", ...buildSongGridReference({ numerator: 3, denominator: 8 }, 120) };
  assert.equal(grid.conventions, null);
  assert.equal(validateToolResult("get_song_grid_reference", grid), grid);
  const overdub = { stateVersion: 1, baseline: null, sessionRecord: true };
  assert.equal(validateToolResult("get_session_midi_overdub_context", overdub), overdub);
});
