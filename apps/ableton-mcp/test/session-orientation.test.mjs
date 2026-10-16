import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTonalEvidence, enrichSessionOrientation } from "../src/session-orientation.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";
import { getPrompt } from "../src/prompts.mjs";

const key = { rootNote: 0, scaleName: "Major", scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };
const note = (pitch, start = 0, duration = 1, extra = {}) => ({ pitch, start, duration, mute: false, ...extra });
const range = { startBeats: 0, endBeats: 8 };

test("tonal evidence preserves relative and modal ambiguity rather than declaring the configured key", () => {
  const result = analyzeTonalEvidence([60, 62, 64, 65, 67, 69, 71].map(p => note(p)), range, key);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.configuredScale.supportFraction, 1);
  const best = result.candidateGroups[0];
  assert.equal(best.supportFraction, 1);
  assert.equal(best.compatibleKeys.length, 7);
  assert.ok(best.compatibleKeys.some(k => k.rootNote === 9 && k.scaleName === "Minor"));
  assert.ok(best.compatibleKeys.some(k => k.rootNote === 2 && k.scaleName === "Dorian"));
  assert.equal(result.confirmedKey, null);
});

test("configured scale conflict is measured without automatically retuning the Set", () => {
  const result = analyzeTonalEvidence([61, 63, 65, 66, 68, 70, 72].map(p => note(p)), range, key);
  assert.ok(result.configuredScale.supportFraction < 0.5);
  assert.equal(result.candidateGroups[0].supportFraction, 1);
  assert.deepEqual(result.configuredScale.offScalePitchClasses, [1, 3, 6, 8, 10]);
  assert.equal(result.confirmedKey, null);
});

test("histograms use only unmuted notes intersecting the focus range, clipped at both boundaries", () => {
  const result = analyzeTonalEvidence([note(60, -1, 2), note(64, 1, 10), note(66, 0, 2, { mute: true }),
    note(67, 4, 1), note(69, -3, 1)], { startBeats: 0, endBeats: 4 }, key);
  assert.deepEqual(result.pitchClasses.map(p => [p.pitchClass, p.durationBeats]), [[0, 1], [4, 3]]);
  assert.equal(result.includedNotes, 2);
  assert.equal(result.status, "insufficient");
});

test("empty, muted, sparse and chromatic material cannot yield a confident key", () => {
  for (const notes of [[], [note(60, 0, 1, { mute: true })], [note(60)]]) {
    const result = analyzeTonalEvidence(notes, range, key);
    assert.equal(result.status, "insufficient");
    assert.equal(result.confirmedKey, null);
  }
  const chromatic = analyzeTonalEvidence(Array.from({ length: 12 }, (_, i) => note(60 + i)), range, key);
  assert.equal(chromatic.status, "ambiguous");
  assert.equal(chromatic.tiedBestGroupCount, 12);
  assert.equal(chromatic.candidatesTruncated, true);
  assert.ok(chromatic.candidateGroups.every(c => c.supportFraction < 0.6));
});

test("tonal evidence rejects malformed notes and invalid windows rather than fabricating evidence", () => {
  for (const notes of [[note(128)], [note(60, 0, -1)], [note(60, NaN)], [note(60, 0, 1, { mute: undefined })]])
    assert.throws(() => analyzeTonalEvidence(notes, range, key));
  assert.throws(() => analyzeTonalEvidence([], { startBeats: 4, endBeats: 0 }, key));
});

function snapshot(status = "available") {
  return { stateVersion: 4, setFingerprint: "set", live: { tempo: 120 },
    musicalContext: { key }, selection: { detailClip: { trackId: "track-0", clipId: "track-0:clip-0" } },
    focus: { status, trackId: "track-0", clipId: "track-0:clip-0", range, notes: [note(60), note(64), note(67)], devices: [] } };
}

test("orientation uses one native observation, exposes bounded evidence, and is discoverable read-only in core", async () => {
  const calls = [];
  const service = new ToolService({ bridge: { request: async (name, args) => {
    calls.push([name, args]); return snapshot();
  } } });
  const route = createRouter(service, { toolProfile: "core" });
  const tools = (await route({ id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.find(t => t.name === "get_session_orientation")?.annotations.readOnlyHint, true);
  calls.length = 0; // Discovery may read examples; the orientation itself is one observation.
  const reply = await route({ id: 2, method: "tools/call", params: { name: "get_session_orientation", arguments: {} } });
  assert.equal(reply.result.structuredContent.focus.tonalEvidence.status, "ambiguous");
  assert.equal(Object.hasOwn(reply.result.structuredContent.focus, "notes"), false);
  assert.deepEqual(calls, [["get_session_orientation", {}]]);
});

test("unavailable pitch evidence stays unavailable for audio, drums, recording, limits and no clip", () => {
  for (const status of ["audio", "drums", "recording", "note_limit", "no_clip"]) {
    const result = enrichSessionOrientation(snapshot(status));
    assert.equal(result.focus.tonalEvidence, null);
    assert.equal(result.focus.status, status);
    assert.equal(Object.hasOwn(result.focus, "notes"), false);
  }
});

test("session and instrument workflows separate configuration from evidence and require user choice before replacement", () => {
  const overview = getPrompt("session-overview").messages[0].content.text;
  assert.match(overview, /get_session_orientation/);
  assert.match(overview, /configured/i);
  assert.match(overview, /ambigui/i);
  const explore = getPrompt("explore-selected-instrument", { request: "warmer synths" }).messages[0].content.text;
  for (const phrase of ["get_session_orientation", "save_live_set", "load_browser_item", "original", "user", "readback", "opaque", "recording"])
    assert.ok(explore.includes(phrase), phrase);
  assert.match(explore, /only.*Serum 2\/Omnisphere\/VPS Avenger/i);
  assert.match(explore, /Before loading.*get_midi_clip_notes_extended.*get_clip_timing/);
  assert.match(explore, /Arrangement.*never.*launch_clip/);
});
