import test from "node:test";
import assert from "node:assert/strict";
import { planDrumVariation, matchDrumVariationReadback } from "../src/drum-variation.mjs";
import { buildSongGridReference } from "../src/song-grid-reference.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const reference = buildSongGridReference({ numerator: 4, denominator: 4 }, 120);
const note = (noteId, pitch, start, velocity = 80) => ({ noteId, pitch, start,
  duration: 0.125, velocity, velocityDeviation: 0, releaseVelocity: 64,
  probability: 1, mute: false });

test("seeded humanization is deterministic, bounded, and preserves accents", () => {
  const observed = { lengthBeats: 8, notes: [
    note(1, 42, 0, 110), note(2, 42, 0.5), note(3, 42, 4.5), note(4, 36, 0, 100)
  ] };
  const options = { grid: "straight16", startBar: 0, bars: 1, laneNotes: [42], seed: 19,
    timingAmount: 0.25, velocityAmount: 8, preserveAccentsAbove: 100 };
  const first = planDrumVariation(reference, observed, options);
  const second = planDrumVariation(reference, observed, options);
  assert.deepEqual(first, second);
  assert.deepEqual(first.changes.map(change => change.noteId), [1, 2]);
  assert.equal(first.changes[0].velocity, undefined);
  assert.ok(Math.abs(first.changes[0].start - 0) <= 0.0625);
  assert.ok(Math.abs(first.changes[1].start - 0.5) <= 0.0625);
  assert.ok(Math.abs(first.changes[1].velocity - 80) <= 8);
  assert.deepEqual(first.preservedNotes.map(item => item.noteId), [3, 4]);
});

test("explicit final-bar fills add grid notes without replacing the groove", () => {
  const observed = { lengthBeats: 8, notes: [note(1, 38, 1), note(2, 42, 0.5)] };
  const plan = planDrumVariation(reference, observed, { grid: "straight16", startBar: 0,
    bars: 2, laneNotes: [38], seed: 7, timingAmount: 0, velocityAmount: 0,
    preserveAccentsAbove: 100,
    fill: { note: 38, grid: "sixteenthTriplet", activeSteps: [19, 21, 23], velocity: 105, gate: 0.5 }
  });
  assert.deepEqual(plan.newNotes.map(item => Math.round(item.start * 1e9)),
    [7, 7 + 1 / 3, 7 + 2 / 3].map(value => Math.round(value * 1e9)));
  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.preservedNotes.map(item => item.noteId).toSorted((a, b) => a - b), [1, 2]);
});

test("variation rejects collisions, empty changes, boundary crossings, and oversized clips", () => {
  const base = { grid: "straight16", startBar: 0, bars: 1, laneNotes: [42], seed: 1,
    timingAmount: 0, velocityAmount: 0, preserveAccentsAbove: 100 };
  assert.throws(() => planDrumVariation(reference, { lengthBeats: 4, notes: [note(1, 42, 0)] }, base),
    /would not change/);
  assert.throws(() => planDrumVariation(reference, { lengthBeats: 4, notes: [note(1, 42, 0)] },
    { ...base, velocityAmount: 1, preserveAccentsAbove: undefined }), /preserveAccentsAbove/);
  assert.throws(() => planDrumVariation(reference, { lengthBeats: 4, notes: [note(1, 42, 3.95)] },
    { ...base, timingAmount: 0.25 }), /boundary/);
  assert.throws(() => planDrumVariation(reference, { lengthBeats: 4, notes: [note(1, 38, 3)] },
    { ...base, fill: { note: 38, grid: "straight16", activeSteps: [13], velocity: 100, gate: 1 } }),
    /collision/);
  assert.throws(() => planDrumVariation(reference, { lengthBeats: 4,
    notes: Array.from({ length: 4097 }, (_, index) => note(index, 42, 0)) },
    { ...base, velocityAmount: 1 }), /4096/);
});

test("readback requires exact preserved notes, changed properties, and added IDs", () => {
  const preserved = note(9, 36, 0, 100);
  const plan = { preservedNotes: [preserved], changes: [{ noteId: 1, start: 0.52, velocity: 77 }],
    changedBefore: [note(1, 42, 0.5, 80)], newNotes: [{ pitch: 38, start: 3.5,
      duration: 0.125, velocity: 105, velocityDeviation: 0, releaseVelocity: 0,
      probability: 1, mute: false }] };
  const changed = { ...note(1, 42, 0.5, 80), start: 0.52, velocity: 77 };
  const added = { ...note(100, 38, 3.5, 105), releaseVelocity: 0 };
  assert.equal(matchDrumVariationReadback(plan, { addedNoteIds: [100] }, [preserved, changed, added]), true);
  assert.equal(matchDrumVariationReadback(plan, { addedNoteIds: [100] }, [
    preserved, { ...changed, start: changed.start - 1.3e-7 }, added
  ]), true);
  assert.equal(matchDrumVariationReadback(plan, { addedNoteIds: [100] }, [
    { ...preserved, probability: 0.5 }, changed, added
  ]), false);
});

test("guarded variation binds native context and verifies the complete result", async () => {
  let stateVersion = 10;
  let corruptNextReadback = false, corruptReadback = false;
  let notes = [note(1, 42, 0.5), note(2, 36, 0, 100)];
  const timing = () => ({ stateVersion, trackId: "track-0", clipId: "track-0:clip-0",
    loop: { enabled: true, startBeats: 0, endBeats: 4 },
    timeSignature: { numerator: 4, denominator: 4 }, launchQuantization: {},
    grooveId: null, availableGrooves: [] });
  const bridge = { async request(method, args) {
    if (method === "get_live_state") return { stateVersion, tempo: 120, setFingerprint: "variation" };
    if (method === "get_song_musical_context") return { stateVersion,
      timeSignature: { numerator: 4, denominator: 4 }, key: {} };
    if (method === "get_clip_timing") return timing();
    if (method === "get_midi_clip_notes_extended") return { stateVersion,
      trackId: corruptReadback ? "track-9" : args.trackId,
      clipId: corruptReadback ? "track-9:clip-9" : args.clipId, lengthBeats: 4, notes };
    if (method === "transform_midi_notes") {
      const changes = new Map(args.changes.map(change => [change.noteId, change]));
      notes = notes.map(item => ({ ...item, ...changes.get(item.noteId) }));
      const addedNoteIds = args.newNotes.map((_, index) => 100 + index);
      notes.push(...args.newNotes.map((item, index) => ({ ...item, noteId: addedNoteIds[index] })));
      stateVersion++;
      corruptReadback = corruptNextReadback;
      return { stateVersion, trackId: args.trackId, clipId: args.clipId, notes, addedNoteIds };
    }
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const args = { expectedStateVersion: 10, trackId: "track-0", clipId: "track-0:clip-0",
    grid: "straight16", startBar: 0, bars: 1, laneNotes: [42], seed: 99,
    timingAmount: 0.2, velocityAmount: 5, preserveAccentsAbove: 100,
    fill: { note: 38, grid: "straight16", activeSteps: [13, 15], velocity: 105, gate: 0.5 } };
  const dry = await service.call("apply_drum_variation", args);
  assert.equal(dry.plan.before.notes.length, 2);
  assert.deepEqual(dry.plan.clipTiming.timeSignature, { numerator: 4, denominator: 4 });
  const result = await service.call("apply_drum_variation", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(result.verification.matchesExpectedNotes, true);
  assert.equal(result.verification.notes.notes.find(item => item.noteId === 2).velocity, 100);
  const nextArgs = { ...args, expectedStateVersion: 11, seed: 100, fill: undefined };
  const nextDry = await service.call("apply_drum_variation", nextArgs);
  corruptNextReadback = true;
  await assert.rejects(() => service.call("apply_drum_variation", { ...nextArgs, dryRun: false,
    confirmationToken: nextDry.confirmation.token, planHash: nextDry.confirmation.planHash }),
  /verification mismatch/);
});

test("drum variation tools expose strict planner and guarded mutation contracts", () => {
  const common = { trackId: "track-0", clipId: "track-0:clip-0", grid: "straight16",
    startBar: 0, bars: 1, laneNotes: [42], seed: 1, timingAmount: 0.2, velocityAmount: 5,
    preserveAccentsAbove: 100 };
  assert.equal(validateToolArguments("plan_drum_variation", common).seed, 1);
  assert.equal(validateToolArguments("apply_drum_variation", { ...common,
    expectedStateVersion: 10 }).expectedStateVersion, 10);
  assert.throws(() => validateToolArguments("plan_drum_variation", { ...common, mystery: true }),
    /invalid tool arguments/);
  const { preserveAccentsAbove, ...withoutAccentProtection } = common;
  assert.throws(() => validateToolArguments("plan_drum_variation", withoutAccentProtection),
    /invalid tool arguments/);
});
