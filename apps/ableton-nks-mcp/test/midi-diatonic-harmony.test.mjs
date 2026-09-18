import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiDiatonicHarmonyReadback, planMidiDiatonicHarmony } from "../src/midi-diatonic-harmony.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0, duration = 1) => ({
  noteId, pitch, start, duration, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});
const clip = { lengthBeats: 4, notes: [note(1, 60), note(2, 64, 1), note(3, 71, 2)] };
const major = { rootNote: 0, scaleName: "Major", scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };

test("diatonic harmony adds literal scale-degree voices across octave boundaries", () => {
  const plan = planMidiDiatonicHarmony(clip, major, { noteIds: [1, 2, 3], degreeOffsets: [2, 4] });
  assert.deepEqual(plan.newNotes.map(({ sourceNoteId, degreeOffset, pitch }) =>
    [sourceNoteId, degreeOffset, pitch]), [
    [1, 2, 64], [1, 4, 67], [2, 2, 67], [2, 4, 71], [3, 2, 74], [3, 4, 77],
  ]);
  assert.deepEqual(plan.scale, major);
});

test("diatonic harmony supports descending and non-heptatonic intervals", () => {
  const wholeTone = { rootNote: 1, scaleName: "Whole Tone", scaleIntervals: [0, 2, 4, 6, 8, 10] };
  const plan = planMidiDiatonicHarmony({ lengthBeats: 4, notes: [note(1, 61), note(2, 71, 1)] },
    wholeTone, { noteIds: [1, 2], degreeOffsets: [-2] });
  assert.deepEqual(plan.newNotes.map(current => current.pitch), [57, 67]);
});

test("diatonic harmony preserves expression and rejects invalid or colliding voices", () => {
  const plan = planMidiDiatonicHarmony(clip, major, { noteIds: [1], degreeOffsets: [2] });
  assert.deepEqual(plan.newNotes[0], { sourceNoteId: 1, degreeOffset: 2, pitch: 64, start: 0, duration: 1,
    velocity: 91, velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false });
  assert.throws(() => planMidiDiatonicHarmony(clip, major,
    { noteIds: [1], degreeOffsets: [0] }), /non-zero/);
  assert.throws(() => planMidiDiatonicHarmony({ lengthBeats: 4, notes: [note(1, 61)] }, major,
    { noteIds: [1], degreeOffsets: [2] }), /not in the current scale/);
  assert.throws(() => planMidiDiatonicHarmony({ lengthBeats: 4, notes: [note(1, 60), note(2, 64)] }, major,
    { noteIds: [1], degreeOffsets: [2] }), /collision/);
});

test("diatonic harmony readback verifies originals and every native addition", () => {
  const plan = planMidiDiatonicHarmony(clip, major, { noteIds: [1, 2], degreeOffsets: [2] });
  const addedNoteIds = [20, 21];
  const observed = [...clip.notes, ...plan.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] }))];
  assert.equal(matchMidiDiatonicHarmonyReadback(plan, { removedNoteIds: [], addedNoteIds }, observed), true);
  assert.equal(matchMidiDiatonicHarmonyReadback(plan, { removedNoteIds: [], addedNoteIds },
    observed.map(current => current.noteId === 20 ? { ...current, probability: 1 } : current)), false);
});

function fixture() {
  let applied = false;
  const context = { key: major, timeSignature: { numerator: 4, denominator: 4 }, quantization: {}, groove: {}, loop: {} };
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { ...context, stateVersion: applied ? 5 : 4 };
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId, ...clip,
    };
    if (method === "get_clip_timing") return { stateVersion: applied ? 5 : 4,
      trackId: args.trackId, clipId: args.clipId, loop: { enabled: true, startBeats: 0, endBeats: 4 },
      timeSignature: { numerator: 4, denominator: 4 } };
    if (method === "replace_midi_notes") {
      applied = true;
      const addedNoteIds = args.newNotes.map((_, index) => 20 + index);
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId, removedNoteIds: [], addedNoteIds,
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

const args = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: [1, 2], degreeOffsets: [2, 4] };

test("guarded diatonic harmony binds Live scale and verifies native additions", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_diatonic_harmony", args);
  assert.deepEqual(planned.plan.newNotes.map(current => current.pitch), [64, 67, 67, 71]);
  const dry = await service.call("apply_midi_diatonic_harmony", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_diatonic_harmony", { ...args, expectedStateVersion: 4, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("diatonic-harmony tools expose strict contracts", () => {
  assert.deepEqual(validateToolArguments("plan_midi_diatonic_harmony", args).degreeOffsets, [2, 4]);
  assert.throws(() => validateToolArguments("plan_midi_diatonic_harmony", { ...args, degreeOffsets: [0] }),
    /invalid tool arguments/);
});
