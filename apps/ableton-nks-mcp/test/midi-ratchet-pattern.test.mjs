import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiRatchetReadback, planMidiRatchetPattern } from "../src/midi-ratchet-pattern.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start, duration = 0.5) => ({
  noteId, pitch, start, duration, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});

const clip = { lengthBeats: 4, notes: [
  note(1, 60, 0), note(2, 64, 0), note(3, 67, 1), note(4, 72, 2),
] };

test("ratchet pattern replaces complete onsets with literal straight and triplet repeats", () => {
  const plan = planMidiRatchetPattern(clip, {
    noteIds: [1, 2, 3, 4], spanBeats: 0.5, repeatCounts: [2, 3], gate: 0.8,
  });
  assert.deepEqual(plan.removeNoteIds, [1, 2, 3, 4]);
  assert.deepEqual(plan.newNotes.map(({ sourceNoteId, pitch, start, duration }) =>
    ({ sourceNoteId, pitch, start, duration })), [
    { sourceNoteId: 1, pitch: 60, start: 0, duration: 0.2 },
    { sourceNoteId: 1, pitch: 60, start: 0.25, duration: 0.2 },
    { sourceNoteId: 2, pitch: 64, start: 0, duration: 0.2 },
    { sourceNoteId: 2, pitch: 64, start: 0.25, duration: 0.2 },
    { sourceNoteId: 3, pitch: 67, start: 1, duration: 2 / 15 },
    { sourceNoteId: 3, pitch: 67, start: 7 / 6, duration: 2 / 15 },
    { sourceNoteId: 3, pitch: 67, start: 4 / 3, duration: 2 / 15 },
    { sourceNoteId: 4, pitch: 72, start: 2, duration: 0.2 },
    { sourceNoteId: 4, pitch: 72, start: 2.25, duration: 0.2 },
  ]);
  assert.deepEqual(plan.newNotes[0], {
    sourceNoteId: 1, pitch: 60, start: 0, duration: 0.2, velocity: 91,
    velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
  });
});

test("ratchet planning rejects partial chords, collisions, overflow, and no-op patterns", () => {
  assert.throws(() => planMidiRatchetPattern(clip, {
    noteIds: [1, 3], spanBeats: 0.5, repeatCounts: [2], gate: 0.8,
  }), /complete onset/);
  assert.throws(() => planMidiRatchetPattern({ ...clip, notes: [...clip.notes, note(5, 67, 2)] }, {
    noteIds: [3], spanBeats: 1.25, repeatCounts: [2], gate: 1,
  }), /collision/);
  assert.throws(() => planMidiRatchetPattern(clip, {
    noteIds: [4], spanBeats: 2.25, repeatCounts: [3], gate: 1,
  }), /beyond the clip/);
  assert.throws(() => planMidiRatchetPattern(clip, {
    noteIds: [3], spanBeats: 0.5, repeatCounts: [1], gate: 1,
  }), /would not change/);
});

test("ratchet readback preserves unrelated notes and every copied note property", () => {
  const plan = planMidiRatchetPattern(clip, {
    noteIds: [3], spanBeats: 0.5, repeatCounts: [3], gate: 0.8,
  });
  const addedNoteIds = [10, 11, 12];
  const finalNotes = [clip.notes[0], clip.notes[1], clip.notes[3],
    ...plan.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] }))];
  assert.equal(matchMidiRatchetReadback(plan, { removedNoteIds: [3], addedNoteIds }, finalNotes), true);
  assert.equal(matchMidiRatchetReadback(plan, { removedNoteIds: [3], addedNoteIds }, [
    ...finalNotes.slice(0, -1), { ...finalNotes.at(-1), probability: 1 },
  ]), false);
});

function serviceFixture() {
  let applied = false;
  const bridge = { async request(method, args) {
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId, ...clip,
    };
    if (method === "get_clip_timing") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId,
      loop: { enabled: true, startBeats: 0, endBeats: 4 },
      timeSignature: { numerator: 4, denominator: 4 },
    };
    if (method === "replace_midi_notes") {
      applied = true;
      const addedNoteIds = args.newNotes.map((_, index) => 10 + index);
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId,
        removedNoteIds: args.removeNoteIds, addedNoteIds,
        notes: [...args.ratchet.preservedNotes,
          ...args.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] }))] };
    }
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const originalCall = service.call.bind(service);
  service.call = async (name, args) => name === "get_song_grid_reference" ? {
    stateVersion: applied ? 5 : 4, setFingerprint: "set-1", tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
  } : originalCall(name, args);
  return { service, applied: () => applied };
}

const toolArgs = { trackId: "track-0", clipId: "track-0:clip-0",
  noteIds: [1, 2, 3, 4], spanBeats: 0.5, repeatCounts: [2, 3], gate: 0.8 };

test("MCP ratchet planning binds exact clip, timing, and song grid", async () => {
  const { service } = serviceFixture();
  const result = await service.call("plan_midi_ratchet_pattern", toolArgs);
  assert.equal(result.stateVersion, 4);
  assert.equal(result.plan.newNotes.length, 9);
  assert.equal(result.context.clipTiming.loop.endBeats, 4);
  assert.equal(result.context.gridReference.setFingerprint, "set-1");
});

test("guarded ratchet application verifies complete replacement readback", async () => {
  const { service, applied } = serviceFixture();
  const args = { ...toolArgs, expectedStateVersion: 4 };
  const dry = await service.call("apply_midi_ratchet_pattern", args);
  assert.equal(dry.plan.operation, "apply_midi_ratchet_pattern");
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_ratchet_pattern", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("ratchet tools expose strict bounded contracts", () => {
  assert.deepEqual(validateToolArguments("plan_midi_ratchet_pattern", toolArgs).repeatCounts, [2, 3]);
  assert.deepEqual(validateToolArguments("apply_midi_ratchet_pattern", {
    ...toolArgs, expectedStateVersion: 4,
  }).noteIds, [1, 2, 3, 4]);
  assert.throws(() => validateToolArguments("plan_midi_ratchet_pattern", {
    ...toolArgs, repeatCounts: [65],
  }), /invalid tool arguments/);
});
