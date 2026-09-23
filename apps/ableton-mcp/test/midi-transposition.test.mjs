import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiTranspositionReadback, planMidiTransposition } from "../src/midi-transposition.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0, duration = 1) => ({
  noteId, pitch, start, duration, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});
const clip = { lengthBeats: 4, notes: [
  note(1, 60), note(2, 64), note(3, 67), note(4, 72, 2),
] };

test("MIDI transposition emits exact pitch-only changes", () => {
  assert.deepEqual(planMidiTransposition(clip, { noteIds: [1, 2, 3], semitones: 7 }), {
    noteIds: [1, 2, 3], semitones: 7,
    changes: [
      { noteId: 1, previous: clip.notes[0], pitch: 67 },
      { noteId: 2, previous: clip.notes[1], pitch: 71 },
      { noteId: 3, previous: clip.notes[2], pitch: 74 },
    ],
  });
});

test("MIDI transposition rejects no-op, range overflow, unknown IDs, and retained-note collisions", () => {
  assert.throws(() => planMidiTransposition(clip, { noteIds: [1], semitones: 0 }), /non-zero/);
  assert.throws(() => planMidiTransposition(clip, { noteIds: [4], semitones: 60 }), /MIDI range/);
  assert.throws(() => planMidiTransposition(clip, { noteIds: [99], semitones: 1 }), /unknown noteId/);
  const collision = { ...clip, notes: [...clip.notes, note(5, 67, 0, 1)] };
  assert.throws(() => planMidiTransposition(collision, { noteIds: [1], semitones: 7 }), /collision/);
});

test("MIDI transposition readback requires stable IDs and unchanged non-pitch state", () => {
  const plan = planMidiTransposition(clip, { noteIds: [1, 2, 3], semitones: -12 });
  const finalNotes = clip.notes.map(current => {
    const change = plan.changes.find(candidate => candidate.noteId === current.noteId);
    return change ? { ...current, pitch: change.pitch } : current;
  });
  assert.equal(matchMidiTranspositionReadback(clip.notes, plan, finalNotes), true);
  assert.equal(matchMidiTranspositionReadback(clip.notes, plan,
    finalNotes.map(current => current.noteId === 2 ? { ...current, probability: 1 } : current)), false);
  assert.equal(matchMidiTranspositionReadback(clip.notes, plan,
    finalNotes.map(current => current.noteId === 4 ? { ...current, pitch: 71 } : current)), false);
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
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId, addedNoteIds: [],
        notes: clip.notes.map(current => {
          const change = args.changes.find(candidate => candidate.noteId === current.noteId);
          return change ? { ...current, pitch: change.pitch } : current;
        }) };
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

const args = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: [1, 2, 3], semitones: 7 };

test("guarded MIDI transposition binds context and verifies native pitch-only mutation", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_transposition", args);
  assert.deepEqual(planned.plan.changes.map(change => change.pitch), [67, 71, 74]);
  const dry = await service.call("apply_midi_transposition", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_transposition", { ...args, expectedStateVersion: 4,
    dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("MIDI-transposition tools expose strict contracts", () => {
  assert.equal(validateToolArguments("plan_midi_transposition", args).semitones, 7);
  assert.throws(() => validateToolArguments("plan_midi_transposition", { ...args, semitones: 0 }),
    /invalid tool arguments/);
});
