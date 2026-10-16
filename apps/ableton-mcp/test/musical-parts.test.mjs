import test from "node:test";
import assert from "node:assert/strict";
import { enrichMidiPartsContext } from "../src/session-orientation.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { createRouter } from "../src/server.mjs";
import { getPrompt } from "../src/prompts.mjs";

const key = { rootNote: 0, scaleName: "Major", scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };
const part = (index, pitches, extra = {}) => ({ trackId: `track-${index}`, clipId: `track-${index}:clip-0`,
  status: "available", range: { startBeats: 0, endBeats: 4 }, rangeBasis: "clip-loop",
  notes: pitches.map(pitch => ({ pitch, start: 0, duration: 1, mute: false })), ...extra });
const snapshot = parts => ({ stateVersion: 3, setFingerprint: "set", musicalContext: { key }, parts });

test("parts retain their own evidence and contribute exact clipped durations to combined compatibility", () => {
  const result = enrichMidiPartsContext(snapshot([
    part(0, [36, 43]), part(1, [60, 64, 67]), part(2, [62, 65, 69, 71])
  ]));
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.coverage.analyzedParts, 3);
  assert.equal(result.parts[0].tonalEvidence.status, "insufficient");
  assert.deepEqual(result.parts[0].pitchRange, { lowest: 36, highest: 43 });
  assert.equal(result.combined.confirmedKey, null);
  assert.equal(result.combined.includedNotes, 9);
  assert.equal(result.combined.candidateGroups[0].supportFraction, 1);
  assert.equal(result.combined.candidateGroups[0].compatibleKeys.length, 7);
  assert.deepEqual(result.combined.pitchClasses.map(p => [p.pitchClass, p.durationBeats]),
    [[0, 2], [2, 1], [4, 1], [5, 1], [7, 2], [9, 1], [11, 1]]);
  assert.equal(result.combined.range, null);
  assert.ok(result.combined.limitations.some(s => /not.*simultaneous/i.test(s)));
  assert.ok(result.parts.every(p => !Object.hasOwn(p, "notes")));
});

test("muted and out-of-range notes do not affect register or combined support", () => {
  const result = enrichMidiPartsContext(snapshot([part(0, [], { notes: [
    { pitch: 60, start: -1, duration: 2, mute: false },
    { pitch: 64, start: 2, duration: 5, mute: false },
    { pitch: 12, start: 0, duration: 1, mute: true },
    { pitch: 127, start: 8, duration: 1, mute: false }
  ] })]));
  assert.deepEqual(result.parts[0].pitchRange, { lowest: 60, highest: 64 });
  assert.deepEqual(result.combined.pitchClasses.map(p => [p.pitchClass, p.durationBeats]), [[0, 1], [4, 2]]);
});

test("partial and wholly unavailable coverage never hide excluded parts", () => {
  for (const status of ["audio", "drums", "recording", "note_limit"]) {
    const excluded = part(1, [], { status });
    const result = enrichMidiPartsContext(snapshot([part(0, [60, 64, 67]), excluded]));
    assert.equal(result.coverage.status, "partial");
    assert.equal(result.coverage.excludedParts, 1);
    assert.equal(result.parts[1].tonalEvidence, null);
    assert.equal(result.parts[1].pitchRange, null);
    const empty = enrichMidiPartsContext(snapshot([excluded]));
    assert.equal(empty.coverage.status, "unavailable");
    assert.equal(empty.combined, null);
  }
});

test("contradictory parts retain their own evidence rather than inventing a common key", () => {
  const result = enrichMidiPartsContext(snapshot([part(0, [60, 64, 67]), part(1, [61, 65, 68])]));
  assert.equal(result.parts[0].tonalEvidence.configuredScale.supportFraction, 1);
  assert.ok(result.parts[1].tonalEvidence.configuredScale.supportFraction < 0.5);
  assert.equal(result.combined.confirmedKey, null);
  assert.equal(result.combined.status, "ambiguous");
});

test("all-profile tool validates explicit unique parts, makes one observation, and returns no raw notes", async () => {
  const calls = [];
  const service = new ToolService({ bridge: { request: async (name, args) => {
    calls.push([name, args]); return snapshot([part(0, [60, 64, 67])]);
  } } });
  const route = createRouter(service);
  const tools = (await route({ id: 1, method: "tools/list" })).result.tools;
  assert.equal(tools.find(t => t.name === "analyze_midi_parts")?.annotations.readOnlyHint, true);
  calls.length = 0;
  const parts = [{ trackId: "track-0", clipId: "track-0:clip-0" }];
  const reply = await route({ id: 2, method: "tools/call", params: { name: "analyze_midi_parts", arguments: { parts } } });
  assert.equal(reply.result.structuredContent.coverage.status, "complete");
  assert.deepEqual(calls, [["analyze_midi_parts", { parts }]]);
  for (const invalid of [[], [...parts, ...parts], Array(9).fill(parts[0])]) {
    const result = await route({ id: 3, method: "tools/call", params: { name: "analyze_midi_parts", arguments: { parts: invalid } } });
    assert.ok(result.error || result.result?.isError);
  }
  assert.equal(calls.length, 1);
});

test("parts workflow resolves exact references and keeps interpretation separate from playback", () => {
  const text = getPrompt("understand-musical-parts", { request: "relate the bass to the chords" }).messages[0].content.text;
  for (const phrase of ["analyze_midi_parts", "list_clips", "list_arrangement_clips", "configured", "excluded", "simultaneous", "role", "probabil", "playback"])
    assert.ok(text.includes(phrase), phrase);
});
