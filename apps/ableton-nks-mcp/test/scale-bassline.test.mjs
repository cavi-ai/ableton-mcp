import test from "node:test";
import assert from "node:assert/strict";
import { planScaleBassline } from "../src/scale-bassline.mjs";
import { ToolService } from "../src/tool-service.mjs";

const cMajor = { rootNote: 0, rootName: "C", scaleName: "Major", scaleMode: true,
  scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };
const base = { degrees: [1, 5], startBeats: 0, chordBeats: 2, stepBeats: 0.5,
  activeSteps: [0, 2, 3], gate: 0.5, velocity: 100, minPitch: 36, maxPitch: 55,
  pitchPattern: "root_fifth" };

test("scale bassline maps progression roots and diatonic fifths onto explicit grid steps", () => {
  const plan = planScaleBassline(cMajor, base);
  assert.deepEqual(plan.notes, [
    { pitch: 36, start: 0, duration: 0.25, velocity: 100, mute: false },
    { pitch: 43, start: 1, duration: 0.25, velocity: 100, mute: false },
    { pitch: 36, start: 1.5, duration: 0.25, velocity: 100, mute: false },
    { pitch: 43, start: 2, duration: 0.25, velocity: 100, mute: false },
    { pitch: 50, start: 3, duration: 0.25, velocity: 100, mute: false },
    { pitch: 43, start: 3.5, duration: 0.25, velocity: 100, mute: false }
  ]);
  assert.deepEqual(plan.harmony.map(({ degree, rootPitchClass, fifthPitchClass }) =>
    ({ degree, rootPitchClass, fifthPitchClass })), [
    { degree: 1, rootPitchClass: 0, fifthPitchClass: 7 },
    { degree: 5, rootPitchClass: 7, fifthPitchClass: 2 }
  ]);
  assert.equal(plan.stepsPerChord, 4);
  assert.equal(plan.lengthBeats, 4);
});

test("root-octave bassline remains grid-locked on triplet subdivisions", () => {
  const stepBeats = 1 / 3;
  const plan = planScaleBassline(cMajor, { ...base, degrees: [1], chordBeats: 2,
    stepBeats, activeSteps: [0, 2, 5], pitchPattern: "root_octave" });
  assert.deepEqual(plan.notes.map(note => note.pitch), [36, 48, 36]);
  assert.deepEqual(plan.notes.map(note => note.start), [0, 2 * stepBeats, 5 * stepBeats]);
});

test("bassline planning rejects invalid grids, steps, registers, and oversized output", () => {
  assert.throws(() => planScaleBassline(cMajor, { ...base, stepBeats: 0.3 }), /divide chordBeats exactly/);
  assert.throws(() => planScaleBassline(cMajor, { ...base, activeSteps: [0, 0] }), /unique/);
  assert.throws(() => planScaleBassline(cMajor, { ...base, activeSteps: [4] }), /within each chord/);
  assert.throws(() => planScaleBassline(cMajor, { ...base, minPitch: 36, maxPitch: 40 }), /fit/);
  assert.throws(() => planScaleBassline(cMajor, { ...base, degrees: [1, 5],
    chordBeats: Number.MAX_VALUE, stepBeats: Number.MAX_VALUE, activeSteps: [0], pitchPattern: "root" }),
  /derived bassline timing must be finite/);
  assert.throws(() => planScaleBassline(cMajor, { ...base, degrees: Array(64).fill(1), chordBeats: 128,
    stepBeats: 1, activeSteps: Array.from({ length: 128 }, (_, index) => index), pitchPattern: "root" }),
  /4096 MIDI notes/);
});

test("MCP bassline planning binds one unchanged native musical context", async () => {
  const bridge = { async request(method) {
    if (method === "get_song_musical_context") return { stateVersion: 70, key: cMajor };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const result = await service.call("plan_scale_bassline", base);
  assert.equal(result.stateVersion, 70);
  assert.deepEqual(result.plan.notes.map(note => note.pitch), [36, 43, 36, 43, 50, 43]);
});

test("guarded bassline creation verifies every native note", async () => {
  let created = false;
  let requestedNotes = [];
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: created ? 72 : 71, key: cMajor };
    if (method === "list_clips") return { stateVersion: 71, trackId: args.trackId,
      clips: [{ id: "track-0:clip-0", name: null, hasClip: false }] };
    if (method === "create_midi_clip") {
      created = true;
      requestedNotes = args.notes;
      return { stateVersion: 72, trackId: args.trackId,
        clip: { id: args.clipId, name: args.name, hasClip: true, lengthBeats: args.lengthBeats, noteCount: args.notes.length } };
    }
    if (method === "get_midi_clip_notes_extended") return { stateVersion: 72, trackId: args.trackId,
      clipId: args.clipId, lengthBeats: 4, notes: requestedNotes.map((note, index) => ({ ...note, noteId: index + 1 })) };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: { search: () => [], get: () => undefined, products: () => [] } });
  const args = { ...base, expectedStateVersion: 71, trackId: "track-0", clipId: "track-0:clip-0", name: "Bassline" };
  const dry = await service.call("create_scale_bassline_clip", args);
  const live = await service.call("create_scale_bassline_clip", {
    ...args, dryRun: false, confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash
  });
  assert.equal(live.observed.clip.noteCount, 6);
  assert.equal(live.verification.matchesRequestedNotes, true);
});
