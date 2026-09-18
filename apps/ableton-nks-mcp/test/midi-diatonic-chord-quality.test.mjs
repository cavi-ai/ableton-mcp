import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiDiatonicChordQualityReadback, planMidiDiatonicChordQuality } from "../src/midi-diatonic-chord-quality.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0) => ({ noteId, pitch, start, duration: 1, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false });
const major = { rootNote: 0, scaleName: "Major", scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };
const clip = { lengthBeats: 4, notes: [note(1, 60), note(2, 64),
  note(3, 72, 2), note(4, 76, 2), note(5, 79, 2), note(6, 83, 2), note(7, 86, 2)] };
const ids = clip.notes.map(current => current.noteId);

test("diatonic chord quality rebuilds mixed onsets as exact scale-native triads", () => {
  const plan = planMidiDiatonicChordQuality(clip, major,
    { noteIds: ids, rootDegrees: [2, 5], chordSize: "triad", mode: "preserve_register" });
  assert.deepEqual(plan.changes.map(({ noteId, pitch }) => [noteId, pitch]),
    [[1, 62], [2, 65], [3, 67], [4, 71], [5, 74]]);
  assert.deepEqual(plan.removeNoteIds, [6, 7]);
  assert.deepEqual(plan.newNotes.map(({ sourceNoteId, pitch }) => [sourceNoteId, pitch]), [[2, 69]]);
});

test("diatonic chord quality supports sevenths, ninths, and deterministic voice-leading roots", () => {
  const triads = { lengthBeats: 4, notes: [note(1, 60), note(2, 64), note(3, 67),
    note(4, 72, 2), note(5, 76, 2), note(6, 79, 2)] };
  const seventh = planMidiDiatonicChordQuality(triads, major,
    { noteIds: triads.notes.map(current => current.noteId), rootDegrees: [1, 2], chordSize: "seventh", mode: "voice_leading" });
  assert.deepEqual(seventh.onsets.map(current => current.targetRootPitch), [60, 62]);
  assert.deepEqual(seventh.newNotes.map(current => current.pitch), [71, 72]);
  const ninth = planMidiDiatonicChordQuality({ lengthBeats: 4, notes: [note(1, 60), note(2, 64), note(3, 67)] }, major,
    { noteIds: [1, 2, 3], rootDegrees: [1], chordSize: "ninth", mode: "preserve_register" });
  assert.deepEqual([...ninth.changes.map(current => current.pitch), ...ninth.newNotes.map(current => current.pitch)],
    [60, 64, 67, 71, 74]);
});

test("diatonic chord quality preserves expression and rejects incomplete or colliding output", () => {
  const plan = planMidiDiatonicChordQuality(clip, major,
    { noteIds: ids, rootDegrees: [2, 5], chordSize: "triad", mode: "preserve_register" });
  assert.equal(plan.newNotes[0].probability, 0.75);
  assert.throws(() => planMidiDiatonicChordQuality(clip, major,
    { noteIds: ids.slice(1), rootDegrees: [2, 5], chordSize: "triad", mode: "preserve_register" }), /complete onset/);
  assert.throws(() => planMidiDiatonicChordQuality(clip, major,
    { noteIds: ids, rootDegrees: [2], chordSize: "triad", mode: "preserve_register" }), /one root degree per onset/);
  const collision = { ...clip, notes: [...clip.notes, note(8, 69, 0.5)] };
  assert.throws(() => planMidiDiatonicChordQuality(collision, major,
    { noteIds: ids, rootDegrees: [2, 5], chordSize: "triad", mode: "preserve_register" }), /collision/);
});

test("diatonic chord-quality readback verifies retained, removed, and added voices", () => {
  const plan = planMidiDiatonicChordQuality(clip, major,
    { noteIds: ids, rootDegrees: [2, 5], chordSize: "triad", mode: "preserve_register" });
  const addedNoteIds = [20];
  const finalNotes = clip.notes.filter(current => !plan.removeNoteIds.includes(current.noteId)).map(current => {
    const change = plan.changes.find(candidate => candidate.noteId === current.noteId);
    return change ? { ...current, pitch: change.pitch } : current;
  }).concat(plan.newNotes.map(current => ({ ...current, noteId: 20 })));
  assert.equal(matchMidiDiatonicChordQualityReadback(plan,
    { removedNoteIds: plan.removeNoteIds, addedNoteIds }, finalNotes), true);
  assert.equal(matchMidiDiatonicChordQualityReadback(plan,
    { removedNoteIds: plan.removeNoteIds, addedNoteIds }, finalNotes.map(current =>
      current.noteId === 20 ? { ...current, velocity: 92 } : current)), false);
});

function fixture() {
  let applied = false;
  const context = { key: major, timeSignature: { numerator: 4, denominator: 4 }, quantization: {}, groove: {}, loop: {} };
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { ...context, stateVersion: applied ? 5 : 4 };
    if (method === "get_midi_clip_notes_extended") return { stateVersion: applied ? 5 : 4,
      trackId: args.trackId, clipId: args.clipId, ...clip };
    if (method === "get_clip_timing") return { stateVersion: applied ? 5 : 4,
      trackId: args.trackId, clipId: args.clipId, loop: { enabled: true, startBeats: 0, endBeats: 4 },
      timeSignature: { numerator: 4, denominator: 4 } };
    if (method === "replace_midi_notes") {
      applied = true;
      const addedNoteIds = args.newNotes.map((_, index) => 20 + index);
      const notes = clip.notes.filter(current => !args.removeNoteIds.includes(current.noteId)).map(current => {
        const change = args.changes.find(candidate => candidate.noteId === current.noteId);
        return change ? { ...current, pitch: change.pitch } : current;
      }).concat(args.newNotes.map((current, index) => ({ ...current, noteId: addedNoteIds[index] })));
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId,
        removedNoteIds: args.removeNoteIds, addedNoteIds, notes };
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

const args = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: ids,
  rootDegrees: [2, 5], chordSize: "triad", mode: "preserve_register" };

test("guarded diatonic chord quality binds Live scale and verifies native replacement", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_diatonic_chord_quality", args);
  assert.deepEqual(planned.plan.removeNoteIds, [6, 7]);
  const dry = await service.call("apply_midi_diatonic_chord_quality", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_diatonic_chord_quality", { ...args, expectedStateVersion: 4,
    dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("diatonic-chord-quality tools expose strict contracts", () => {
  assert.equal(validateToolArguments("plan_midi_diatonic_chord_quality", args).chordSize, "triad");
  assert.throws(() => validateToolArguments("plan_midi_diatonic_chord_quality", { ...args, chordSize: "sixth" }),
    /invalid tool arguments/);
});
