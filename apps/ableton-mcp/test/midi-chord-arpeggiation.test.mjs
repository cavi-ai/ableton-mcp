import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiChordArpeggiationReadback, planMidiChordArpeggiation } from "../src/midi-chord-arpeggiation.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0, duration = 1) => ({
  noteId, pitch, start, duration, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});
const clip = { lengthBeats: 4, notes: [
  note(1, 60), note(2, 64), note(3, 67), note(4, 71),
  note(5, 62, 2), note(6, 65, 2), note(7, 69, 2), note(8, 72, 2),
] };
const ids = clip.notes.map(current => current.noteId);

test("chord arpeggiation emits literal up, down, up-down, and seeded random traversals", () => {
  const pitches = (mode, seed = 7) => {
    const plan = planMidiChordArpeggiation(clip,
      { noteIds: ids.slice(0, 4), mode, stepBeats: 0.25, gate: 0.8, seed });
    const source = new Map(clip.notes.map(current => [current.noteId, current.pitch]));
    return [...plan.changes.map(current => source.get(current.noteId)), ...plan.newNotes.map(current => current.pitch)];
  };
  assert.deepEqual(pitches("up"), [60, 64, 67, 71]);
  assert.deepEqual(pitches("down"), [71, 67, 64, 60]);
  assert.deepEqual(pitches("up_down"), [60, 64, 67, 71, 67, 64]);
  assert.deepEqual(pitches("random"), [60, 67, 71, 64]);
  assert.deepEqual(pitches("random"), pitches("random"));
});

test("arpeggiated notes preserve source expression fields and apply step and gate", () => {
  const plan = planMidiChordArpeggiation(clip,
    { noteIds: ids.slice(0, 4), mode: "up", stepBeats: 0.25, gate: 0.8, seed: 0 });
  assert.deepEqual(plan.changes[1], {
    noteId: 2, previous: clip.notes[1], start: 0.25, duration: 0.2,
  });
  assert.deepEqual(plan.newNotes, []);
});

test("chord arpeggiation rejects partial chords, invalid timing, overflow, and retained-note collisions", () => {
  assert.throws(() => planMidiChordArpeggiation(clip,
    { noteIds: [1, 2, 3], mode: "up", stepBeats: 0.25, gate: 1, seed: 0 }), /complete onset/);
  assert.throws(() => planMidiChordArpeggiation(clip,
    { noteIds: ids.slice(0, 4), mode: "up", stepBeats: 0.25, gate: 1.1, seed: 0 }), /gate/);
  assert.throws(() => planMidiChordArpeggiation(clip,
    { noteIds: ids.slice(0, 4), mode: "up_down", stepBeats: 0.5, gate: 1, seed: 0 }), /boundary/);
  const collision = { ...clip, notes: [...clip.notes, note(9, 64, 0.3, 0.2)] };
  assert.throws(() => planMidiChordArpeggiation(collision,
    { noteIds: ids.slice(0, 4), mode: "up", stepBeats: 0.25, gate: 1, seed: 0 }), /collision/);
});

test("arpeggiation readback verifies stable modified IDs and additions", () => {
  const plan = planMidiChordArpeggiation(clip,
    { noteIds: ids.slice(0, 4), mode: "up_down", stepBeats: 0.25, gate: 0.8, seed: 0 });
  const addedNoteIds = [20, 21];
  const changed = clip.notes.map(current => {
    const change = plan.changes.find(candidate => candidate.noteId === current.noteId);
    return change ? { ...current, start: change.start, duration: change.duration } : current;
  });
  const finalNotes = [...changed,
    ...plan.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] }))];
  const mutation = { addedNoteIds };
  assert.equal(matchMidiChordArpeggiationReadback(clip.notes, plan, mutation, finalNotes), true);
  assert.equal(matchMidiChordArpeggiationReadback(clip.notes, plan,
    mutation, finalNotes.map(current => current.noteId === 2 ? { ...current, probability: 1 } : current)), false);
  assert.equal(matchMidiChordArpeggiationReadback(clip.notes, plan,
    { ...mutation, addedNoteIds: [] }, finalNotes), false);
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
    if (method === "transform_midi_notes") {
      applied = true;
      const addedNoteIds = args.newNotes.map((_, index) => 20 + index);
      const changed = clip.notes.map(current => {
        const change = args.changes.find(candidate => candidate.noteId === current.noteId);
        return change ? { ...current, start: change.start, duration: change.duration } : current;
      });
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId,
        addedNoteIds, notes: [...changed,
          ...args.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] }))] };
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

const args = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: ids.slice(0, 4),
  mode: "up_down", stepBeats: 0.25, gate: 0.8, seed: 7 };

test("guarded chord arpeggiation binds context and verifies native in-place transform", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_chord_arpeggiation", args);
  assert.deepEqual(planned.plan.newNotes.map(current => current.pitch), [67, 64]);
  const dry = await service.call("apply_midi_chord_arpeggiation", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_chord_arpeggiation", { ...args, expectedStateVersion: 4,
    dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("chord-arpeggiation tools expose strict contracts", () => {
  assert.equal(validateToolArguments("plan_midi_chord_arpeggiation", args).mode, "up_down");
  assert.throws(() => validateToolArguments("plan_midi_chord_arpeggiation", { ...args, gate: 0 }),
    /invalid tool arguments/);
});
