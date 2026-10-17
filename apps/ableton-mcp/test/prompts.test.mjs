import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { getPrompt, listPrompts } from "../src/prompts.mjs";

test("MCP discovery lists every prompt with schema-shaped arguments", async () => {
  const route = createRouter({ call: async () => ({}) });
  const listed = await route({ id: 1, method: "prompts/list" });
  const names = listed.result.prompts.map(prompt => prompt.name).sort();
  assert.deepEqual(names, ["add-send-effect", "arrange-session-ideas", "arrangement-rework", "audition-arrangement-passage", "audition-recorded-takes", "balance-mix", "build-layered-instrument", "build-producer-chain", "build-sample-instrument", "build-session-scene", "build-shared-return-effect", "chop-sample-groove", "compare-device-ab", "compare-mix-to-reference", "create-musical-sketch", "crossfade-parts", "develop-selected-audio-clip", "develop-selected-midi-clip", "diagnose-silent-part", "duck-against-source", "explore-selected-instrument", "export-audio-mix", "export-midi-clip", "freeze-track-processing", "group-session-tracks", "harmonize-clip", "import-midi-file", "inspect-recorded-takes", "keep-device-sound", "keep-looper-performance", "keep-played-midi", "listen-to-live-output", "match-midi-feel", "organize-session", "perform-repeat-fill", "perform-session-clip", "prepare-project-handoff", "print-processed-midi", "print-track-to-audio", "produce-drum-pattern", "record-arrangement-take", "record-session-take", "refine-instrument-sound", "resample-to-instrument", "resume-arrangement-tracks", "resume-parameter-automation", "resume-session-work", "reuse-session-clip", "session-overview", "set-up-sidechain-ducking", "shape-clip-automation", "shape-rack-performance", "sketch-midi-from-audio", "try-clip-groove", "understand-musical-parts", "ungroup-session-tracks"]);
  for (const prompt of listed.result.prompts) {
    assert.ok(prompt.description);
    for (const argument of prompt.arguments) {
      assert.ok(argument.name && argument.description, `${prompt.name} argument shape`);
    }
  }
});

test("prompts/get renders arguments into user messages and validates required args", async () => {
  const route = createRouter({ call: async () => ({}) });
  const missing = await route({ id: 1, method: "prompts/get", params: { name: "harmonize-clip", arguments: {} } });
  assert.equal(missing.error?.code, -32602);
  assert.match(missing.error.message, /trackId/);
  const rendered = await route({ id: 2, method: "prompts/get", params: {
    name: "harmonize-clip", arguments: { trackId: "track-2", clipId: "track-2:arrangement-clip-0" } } });
  const text = rendered.result.messages[0].content.text;
  assert.equal(rendered.result.messages[0].role, "user");
  assert.match(text, /track-2:arrangement-clip-0/);
  assert.match(text, /analyze_midi_clip_scale/);
  assert.match(text, /dry-run plan/);
  const survey = await getPrompt("session-overview");
  assert.equal(survey.messages.length, 1);
  assert.match(survey.messages[0].content.text, /get_song_musical_context/);
});

test("prompts/get rejects unknown prompt names", async () => {
  assert.throws(() => getPrompt("nonexistent"), /unknown prompt/);
});

test("overview can request a Set and distinguishes a missing bridge from closed Live", async () => {
  const prompt = getPrompt("session-overview", { setPath: "/tmp/Idea.als" });
  const text = prompt.messages[0].content.text;
  assert.match(text, /\/tmp\/Idea\.als/);
  assert.match(text, /mode.*launch/);
  assert.match(text, /unreachable bridge.*not.*closed/i);
  assert.match(text, /opened.*true/);
});

test("resume discovery requires the user's intended continuation and never calls Live", async () => {
  let calls = 0;
  const route = createRouter({ call: async () => { calls++; throw new Error("prompt rendering must not call Live"); } });
  const missing = await route({ id: 1, method: "prompts/get", params: { name: "resume-session-work", arguments: {} } });
  assert.equal(missing.error?.code, -32602);
  assert.match(missing.error.message, /request/);
  const response = await route({ id: 2, method: "prompts/get", params: { name: "resume-session-work", arguments: {
    request: "Continue comparing bass instruments", previousContext: "The alternative was selected before reconnecting."
  } } });
  const text = response.result.messages[0].content.text;
  assert.match(text, /Continue comparing bass instruments/);
  assert.match(text, /The alternative was selected before reconnecting/);
  assert.match(text, /get_session_orientation/);
  assert.match(text, /get_instrument_comparison/);
  assert.match(text, /get_live_audio_capture/);
  assert.match(text, /get_midi_clip_notes_extended/);
  assert.match(text, /stateVersion alone/);
  assert.match(text, /unknown/);
  assert.match(text, /authorization/);
  assert.match(text, /never.*replay/i);
  assert.equal(calls, 0);
});

test("instrument replacement workflow establishes a verified working Set with Save As", () => {
  const text = getPrompt("explore-selected-instrument", { request: "warmer synth" }).messages[0].content.text;
  assert.match(text, /save_live_set.*path/);
  assert.match(text, /saved: true/);
  assert.match(text, /project folder/);
});
