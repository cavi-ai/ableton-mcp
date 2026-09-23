import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiScaleChordRemappingReadback, planMidiScaleChordRemapping } from "../src/midi-scale-chord-remapping.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0) => ({ noteId, pitch, start, duration: 1, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false });
const major = { rootNote: 0, scaleName: "Major", scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };
const clip = { lengthBeats: 4, notes: [
  note(1, 60), note(2, 64), note(3, 67), note(4, 72, 2), note(5, 76, 2), note(6, 79, 2),
] };
const ids = clip.notes.map(current => current.noteId);

test("scale chord remapping anchors complete onsets to explicit progression degrees", () => {
  const plan = planMidiScaleChordRemapping(clip, major,
    { noteIds: ids, targetDegrees: [2, 5], mode: "preserve_register" });
  assert.deepEqual(plan.changes.map(({ noteId, pitch }) => [noteId, pitch]),
    [[1, 62], [2, 66], [3, 69], [4, 67], [5, 71], [6, 74]]);
  assert.deepEqual(plan.onsets.map(({ targetDegree, sourceBassPitch, targetBassPitch }) =>
    [targetDegree, sourceBassPitch, targetBassPitch]), [[2, 60, 62], [5, 72, 67]]);
});

test("voice-leading mode chooses the nearest octave to the previous remapped bass", () => {
  const preserved = planMidiScaleChordRemapping(clip, major,
    { noteIds: ids, targetDegrees: [1, 2], mode: "preserve_register" });
  const led = planMidiScaleChordRemapping(clip, major,
    { noteIds: ids, targetDegrees: [1, 2], mode: "voice_leading" });
  assert.deepEqual(preserved.onsets.map(current => current.targetBassPitch), [60, 74]);
  assert.deepEqual(led.onsets.map(current => current.targetBassPitch), [60, 62]);
});

test("scale chord remapping preserves expression and rejects ambiguous or unsafe edits", () => {
  const plan = planMidiScaleChordRemapping(clip, major,
    { noteIds: ids, targetDegrees: [2, 5], mode: "preserve_register" });
  assert.deepEqual(plan.changes[0].previous, clip.notes[0]);
  assert.throws(() => planMidiScaleChordRemapping(clip, major,
    { noteIds: ids.slice(1), targetDegrees: [2, 5], mode: "preserve_register" }), /complete onset/);
  assert.throws(() => planMidiScaleChordRemapping(clip, major,
    { noteIds: ids, targetDegrees: [2], mode: "preserve_register" }), /one target degree per onset/);
  const collision = { ...clip, notes: [...clip.notes, note(7, 62, 0.5)] };
  assert.throws(() => planMidiScaleChordRemapping(collision, major,
    { noteIds: ids, targetDegrees: [2, 5], mode: "preserve_register" }), /collision/);
});

test("scale chord remapping readback verifies stable IDs and all note properties", () => {
  const plan = planMidiScaleChordRemapping(clip, major,
    { noteIds: ids, targetDegrees: [2, 5], mode: "preserve_register" });
  const finalNotes = clip.notes.map(current => {
    const change = plan.changes.find(candidate => candidate.noteId === current.noteId);
    return { ...current, pitch: change.pitch };
  });
  assert.equal(matchMidiScaleChordRemappingReadback(clip.notes, plan, finalNotes), true);
  assert.equal(matchMidiScaleChordRemappingReadback(clip.notes, plan,
    finalNotes.map(current => current.noteId === 2 ? { ...current, velocity: 92 } : current)), false);
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
    if (method === "transform_midi_notes") {
      applied = true;
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId, addedNoteIds: [],
        notes: clip.notes.map(current => ({ ...current,
          pitch: args.changes.find(change => change.noteId === current.noteId).pitch })) };
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
  targetDegrees: [2, 5], mode: "preserve_register" };

test("guarded scale chord remapping binds Live scale and verifies native mutation", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_scale_chord_remapping", args);
  assert.deepEqual(planned.plan.onsets.map(current => current.targetBassPitch), [62, 67]);
  const dry = await service.call("apply_midi_scale_chord_remapping", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_scale_chord_remapping", { ...args, expectedStateVersion: 4,
    dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("scale-chord-remapping tools expose strict contracts", () => {
  assert.deepEqual(validateToolArguments("plan_midi_scale_chord_remapping", args).targetDegrees, [2, 5]);
  assert.throws(() => validateToolArguments("plan_midi_scale_chord_remapping", { ...args, targetDegrees: [0] }),
    /invalid tool arguments/);
});
