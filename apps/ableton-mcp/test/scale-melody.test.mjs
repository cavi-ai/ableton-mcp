import test from "node:test";
import assert from "node:assert/strict";
import { planScaleMelody } from "../src/scale-melody.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const cMajor = { rootNote: 0, rootName: "C", scaleName: "Major", scaleMode: true,
  scaleIntervals: [0, 2, 4, 5, 7, 9, 11] };
const grid = { stateVersion: 20, tempoBpm: 120,
  timeSignature: { numerator: 4, denominator: 4 }, barLengthBeats: 4,
  grids: {
    straight16: { stepsPerQuarter: 4, stepsPerBar: 16, barBoundaryOnGrid: true },
    eighthTriplet: { stepsPerQuarter: 3, stepsPerBar: 12, barBoundaryOnGrid: true },
    sixteenthTriplet: { stepsPerQuarter: 6, stepsPerBar: 24, barBoundaryOnGrid: true }
  } };
const base = { grid: "straight16", motifBars: 1, repeats: 2, gate: 0.8,
  velocity: 96, basePitch: 60, minPitch: 48, maxPitch: 84,
  events: [
    { step: 0, degree: 1 },
    { step: 2, degree: 3, velocity: 110 },
    { step: 6, degree: 5, octaveOffset: -1 },
    { step: 12, degree: 8 }
  ] };

test("scale melody maps explicit degrees and accents onto a repeated straight-grid motif", () => {
  const plan = planScaleMelody(cMajor, grid, base);
  assert.equal(plan.lengthBeats, 8);
  assert.equal(plan.stepsPerMotif, 16);
  assert.deepEqual(plan.notes, [
    { pitch: 60, start: 0, duration: 0.2, velocity: 96, mute: false },
    { pitch: 64, start: 0.5, duration: 0.2, velocity: 110, mute: false },
    { pitch: 55, start: 1.5, duration: 0.2, velocity: 96, mute: false },
    { pitch: 72, start: 3, duration: 0.2, velocity: 96, mute: false },
    { pitch: 60, start: 4, duration: 0.2, velocity: 96, mute: false },
    { pitch: 64, start: 4.5, duration: 0.2, velocity: 110, mute: false },
    { pitch: 55, start: 5.5, duration: 0.2, velocity: 96, mute: false },
    { pitch: 72, start: 7, duration: 0.2, velocity: 96, mute: false }
  ]);
  assert.deepEqual(plan.motif.map(({ step, degree, pitch, noteName }) => ({ step, degree, pitch, noteName })), [
    { step: 0, degree: 1, pitch: 60, noteName: "C" },
    { step: 2, degree: 3, pitch: 64, noteName: "E" },
    { step: 6, degree: 5, pitch: 55, noteName: "G" },
    { step: 12, degree: 8, pitch: 72, noteName: "C" }
  ]);
});

test("scale melody supports exact triplet steps and leaves omitted steps as rests", () => {
  const plan = planScaleMelody(cMajor, grid, { ...base, grid: "sixteenthTriplet", repeats: 1,
    events: [{ step: 0, degree: 1 }, { step: 5, degree: 2 }, { step: 23, degree: 7 }] });
  assert.ok(plan.notes.map(note => note.start).every((start, index) =>
    Math.abs(start - [0, 5 / 6, 23 / 6][index]) < 1e-12));
  assert.equal(plan.notes.length, 3);
  assert.equal(plan.lengthBeats, 4);
});

test("scale melody rejects invalid context, grid, events, register, and output size", () => {
  assert.throws(() => planScaleMelody({ ...cMajor, scaleIntervals: [0, 2, 3] }, grid, base), /scale intervals/);
  assert.throws(() => planScaleMelody(cMajor, { ...grid, grids: { ...grid.grids,
    eighthTriplet: { stepsPerQuarter: 3, stepsPerBar: 4.5, barBoundaryOnGrid: false } } },
  { ...base, grid: "eighthTriplet" }), /bar boundary/);
  assert.throws(() => planScaleMelody(cMajor, grid, { ...base,
    events: [{ step: 0, degree: 1 }, { step: 0, degree: 3 }] }), /unique/);
  assert.throws(() => planScaleMelody(cMajor, grid, { ...base, events: [{ step: 16, degree: 1 }] }), /integer from 0 to 15/);
  assert.throws(() => planScaleMelody(cMajor, grid, { ...base, basePitch: 61 }), /root pitch class/);
  assert.throws(() => planScaleMelody(cMajor, grid, { ...base, maxPitch: 64,
    events: [{ step: 0, degree: 8 }] }), /requested MIDI range/);
  assert.throws(() => planScaleMelody(cMajor, grid, { ...base, grid: "sixteenthTriplet",
    motifBars: 16, repeats: 16,
    events: Array.from({ length: 257 }, (_, step) => ({ step, degree: 1 })) }), /4096 MIDI notes/);
});

test("MCP melody planning binds one unchanged key and grid context", async () => {
  const bridge = { async request(method) {
    if (method === "get_song_musical_context") return { stateVersion: 20, key: cMajor };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  service.call = service.call.bind(service);
  const original = service.call;
  service.call = async (name, args) => name === "get_song_grid_reference" ? grid : original(name, args);
  const result = await service.call("plan_scale_melody", base);
  assert.equal(result.stateVersion, 20);
  assert.equal(result.plan.notes.length, 8);
});

test("guarded melody creation verifies every generated native note", async () => {
  let created = false;
  let requestedNotes = [];
  const bridge = { async request(method, args) {
    if (method === "get_song_musical_context") return { stateVersion: created ? 22 : 21, key: cMajor };
    if (method === "list_clips") return { stateVersion: 21, trackId: args.trackId,
      clips: [{ id: "track-0:clip-0", name: null, hasClip: false }] };
    if (method === "create_midi_clip") {
      created = true;
      requestedNotes = args.notes;
      return { stateVersion: 23, trackId: args.trackId,
        clip: { id: args.clipId, name: args.name, hasClip: true,
          lengthBeats: args.lengthBeats, noteCount: args.notes.length },
        notes: requestedNotes.map((note, index) => ({ ...note, noteId: index + 1 })) };
    }
    if (method === "get_midi_clip_notes_extended") return { stateVersion: 22, trackId: args.trackId,
      clipId: args.clipId, lengthBeats: 8,
      notes: requestedNotes.map((note, index) => ({ ...note, noteId: index + 1 })) };
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const original = service.call.bind(service);
  service.call = async (name, args) => name === "get_song_grid_reference" ?
    { ...grid, stateVersion: created ? 22 : 21 } : original(name, args);
  const args = { ...base, expectedStateVersion: 21, trackId: "track-0",
    clipId: "track-0:clip-0", name: "Lead Motif" };
  const dry = await service.call("create_scale_melody_clip", args);
  const live = await service.call("create_scale_melody_clip", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.clip.noteCount, 8);
  assert.equal(live.observed.stateVersion, 23);
  assert.equal(live.verification.matchesRequestedNotes, true);
});

test("scale melody tools expose strict planner and guarded creation contracts", () => {
  assert.equal(validateToolArguments("plan_scale_melody", base).events.length, 4);
  assert.equal(validateToolArguments("create_scale_melody_clip", { ...base,
    expectedStateVersion: 21, trackId: "track-0", clipId: "track-0:clip-0",
    name: "Lead Motif" }).expectedStateVersion, 21);
  assert.throws(() => validateToolArguments("plan_scale_melody", { ...base, mystery: true }),
    /invalid tool arguments/);
  assert.throws(() => validateToolArguments("plan_scale_melody", { ...base,
    events: [{ step: 0, degree: 1, unknown: true }] }), /invalid tool arguments/);
});
