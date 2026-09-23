import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiChordDoublingReadback, planMidiChordDoubling } from "../src/midi-chord-doubling.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0) => ({
  noteId, pitch, start, duration: 1, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});
const clip = { lengthBeats: 4, notes: [
  note(1, 60), note(2, 64), note(3, 67), note(4, 71),
  note(5, 62, 1), note(6, 65, 1), note(7, 69, 1), note(8, 72, 1),
] };
const ids = clip.notes.map(current => current.noteId);

test("chord doubling emits literal bass, top, and outer octave copies", () => {
  const pitches = mode => planMidiChordDoubling(clip, { noteIds: ids, mode }).newNotes
    .map(({ sourceNoteId, pitch, start }) => [sourceNoteId, pitch, start]);
  assert.deepEqual(pitches("bass_octave_down"), [[1, 48, 0], [5, 50, 1]]);
  assert.deepEqual(pitches("top_octave_up"), [[4, 83, 0], [8, 84, 1]]);
  assert.deepEqual(pitches("outer_octaves"), [[1, 48, 0], [4, 83, 0], [5, 50, 1], [8, 84, 1]]);
});

test("doubled notes preserve every supported source property", () => {
  const plan = planMidiChordDoubling(clip, { noteIds: ids, mode: "bass_octave_down" });
  assert.deepEqual(plan.newNotes[0], {
    sourceNoteId: 1, pitch: 48, start: 0, duration: 1, velocity: 91,
    velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
  });
  assert.deepEqual(plan.preservedNotes, clip.notes);
});

test("chord doubling rejects partial onsets, undersized chords, range overflow, and collisions", () => {
  assert.throws(() => planMidiChordDoubling(clip, { noteIds: ids.slice(1), mode: "bass_octave_down" }),
    /complete onset/);
  assert.throws(() => planMidiChordDoubling({ lengthBeats: 4, notes: [note(1, 60)] },
    { noteIds: [1], mode: "top_octave_up" }), /at least two/);
  assert.throws(() => planMidiChordDoubling({ lengthBeats: 4, notes: [note(1, 0), note(2, 4)] },
    { noteIds: [1, 2], mode: "bass_octave_down" }), /MIDI pitch range/);
  const collision = { ...clip, notes: [...clip.notes, note(9, 48, 0.5)] };
  assert.throws(() => planMidiChordDoubling(collision, { noteIds: ids, mode: "bass_octave_down" }),
    /collision/);
});

test("doubling readback verifies every original and added note", () => {
  const plan = planMidiChordDoubling(clip, { noteIds: ids, mode: "outer_octaves" });
  const addedNoteIds = [20, 21, 22, 23];
  const observed = [...clip.notes,
    ...plan.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] }))];
  assert.equal(matchMidiChordDoublingReadback(plan, { removedNoteIds: [], addedNoteIds }, observed), true);
  assert.equal(matchMidiChordDoublingReadback(plan, { removedNoteIds: [], addedNoteIds },
    observed.map(current => current.noteId === 21 ? { ...current, probability: 1 } : current)), false);
  assert.equal(matchMidiChordDoublingReadback(plan, { removedNoteIds: [], addedNoteIds }, observed.slice(1)), false);
});

function fixture() {
  let applied = false;
  const bridge = { async request(method, args) {
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId, ...clip,
    };
    if (method === "get_clip_timing") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId,
      loop: { enabled: true, startBeats: 0, endBeats: 4 }, timeSignature: { numerator: 4, denominator: 4 },
    };
    if (method === "replace_midi_notes") {
      applied = true;
      const addedNoteIds = args.newNotes.map((_, index) => 20 + index);
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId,
        removedNoteIds: [], addedNoteIds,
        notes: [...clip.notes, ...args.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] }))] };
    }
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const call = service.call.bind(service);
  service.call = async (name, args) => name === "get_song_grid_reference" ? {
    stateVersion: applied ? 5 : 4, setFingerprint: "set-1", tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
  } : call(name, args);
  return { service, applied: () => applied };
}

const args = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: ids, mode: "outer_octaves" };

test("guarded chord doubling binds context and verifies all native additions", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_chord_doubling", args);
  assert.deepEqual(planned.plan.newNotes.map(current => current.pitch), [48, 83, 50, 84]);
  const dry = await service.call("apply_midi_chord_doubling", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_chord_doubling", { ...args, expectedStateVersion: 4, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("chord-doubling tools expose strict contracts", () => {
  assert.equal(validateToolArguments("plan_midi_chord_doubling", args).mode, "outer_octaves");
  assert.throws(() => validateToolArguments("plan_midi_chord_doubling", { ...args, mode: "unison" }),
    /invalid tool arguments/);
});
