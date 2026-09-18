import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiDiatonicTranspositionReadback, planMidiDiatonicTransposition } from "../src/midi-diatonic-transposition.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0, duration = 1) => ({
  noteId, pitch, start, duration, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});
const clip = { lengthBeats: 4, notes: [
  note(1, 60), note(2, 64), note(3, 71), note(4, 72, 2),
] };
const major = { rootNote: 0, scaleName: "Major", scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };

test("diatonic transposition crosses scale and octave boundaries by degree", () => {
  const plan = planMidiDiatonicTransposition(clip, major, { noteIds: [1, 2, 3], scaleSteps: 1 });
  assert.deepEqual(plan.changes.map(change => ({ pitch: change.pitch, degree: change.degree })), [
    { pitch: 62, degree: 2 }, { pitch: 65, degree: 4 }, { pitch: 72, degree: 1 },
  ]);
  assert.deepEqual(plan.scale, major);
});

test("diatonic transposition supports non-heptatonic scales and descending motion", () => {
  const wholeTone = { rootNote: 1, scaleName: "Whole Tone", scaleIntervals: [0, 2, 4, 6, 8, 10] };
  const local = { lengthBeats: 4, notes: [note(1, 61), note(2, 71)] };
  assert.deepEqual(planMidiDiatonicTransposition(local, wholeTone,
    { noteIds: [1, 2], scaleSteps: -1 }).changes.map(change => change.pitch), [59, 69]);
});

test("diatonic transposition rejects chromatic notes, range overflow, no-op, and collisions", () => {
  assert.throws(() => planMidiDiatonicTransposition(clip, major,
    { noteIds: [1], scaleSteps: 0 }), /non-zero/);
  assert.throws(() => planMidiDiatonicTransposition({ lengthBeats: 4, notes: [note(1, 61)] }, major,
    { noteIds: [1], scaleSteps: 1 }), /not in the current scale/);
  assert.throws(() => planMidiDiatonicTransposition({ lengthBeats: 4, notes: [note(1, 127)] }, major,
    { noteIds: [1], scaleSteps: 1 }), /MIDI range/);
  const collision = { lengthBeats: 4, notes: [note(1, 60), note(2, 62)] };
  assert.throws(() => planMidiDiatonicTransposition(collision, major,
    { noteIds: [1], scaleSteps: 1 }), /collision/);
});

test("diatonic readback preserves stable IDs and every non-pitch field", () => {
  const plan = planMidiDiatonicTransposition(clip, major, { noteIds: [1, 2, 3], scaleSteps: 2 });
  const finalNotes = clip.notes.map(current => {
    const change = plan.changes.find(candidate => candidate.noteId === current.noteId);
    return change ? { ...current, pitch: change.pitch } : current;
  });
  assert.equal(matchMidiDiatonicTranspositionReadback(clip.notes, plan, finalNotes), true);
  assert.equal(matchMidiDiatonicTranspositionReadback(clip.notes, plan,
    finalNotes.map(current => current.noteId === 2 ? { ...current, velocity: 92 } : current)), false);
});

function fixture() {
  let applied = false;
  const context = { stateVersion: applied ? 5 : 4, key: major,
    timeSignature: { numerator: 4, denominator: 4 }, quantization: {}, groove: {}, loop: {} };
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { ...context, stateVersion: applied ? 5 : 4 };
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

const args = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: [1, 2, 3], scaleSteps: 1 };

test("guarded diatonic transposition binds Live scale and verifies native mutation", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_diatonic_transposition", args);
  assert.deepEqual(planned.plan.changes.map(change => change.pitch), [62, 65, 72]);
  const dry = await service.call("apply_midi_diatonic_transposition", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_diatonic_transposition", { ...args, expectedStateVersion: 4,
    dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("diatonic-transposition tools expose strict contracts", () => {
  assert.equal(validateToolArguments("plan_midi_diatonic_transposition", args).scaleSteps, 1);
  assert.throws(() => validateToolArguments("plan_midi_diatonic_transposition", { ...args, scaleSteps: 0 }),
    /invalid tool arguments/);
});
