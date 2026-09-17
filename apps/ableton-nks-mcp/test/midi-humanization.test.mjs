import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiHumanizationReadback, planMidiHumanization } from "../src/midi-humanization.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start, duration, velocity) => ({
  noteId, pitch, start, duration, velocity,
  velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false,
});

test("MIDI humanization produces literal seeded timing and velocity changes", () => {
  const clip = { lengthBeats: 4, notes: [
    note(7, 60, 0.01, 0.5, 100),
    note(8, 64, 2, 0.5, 90),
  ] };
  const result = planMidiHumanization(clip, {
    noteIds: [7, 8], seed: 7, gridBeats: 0.25,
    maxTimingOffsetBeats: 0.05, maxVelocityOffset: 10,
  });

  assert.deepEqual(result.changes, [
    { noteId: 7, previous: clip.notes[0], start: 0, velocity: 108 },
    { noteId: 8, previous: clip.notes[1], start: 2.0112491666339336, velocity: 99 },
  ]);
  assert.deepEqual(result.options, {
    seed: 7, gridBeats: 0.25, maxTimingOffsetBeats: 0.05, maxVelocityOffset: 10,
  });
});

test("MIDI humanization is reproducible and rejects unsafe or meaningless plans", () => {
  const clip = { lengthBeats: 4, notes: [
    note(7, 60, 0, 0.25, 100),
    note(8, 60, 0.26, 0.25, 90),
  ] };
  const options = { noteIds: [8], seed: 7, gridBeats: 0.25,
    maxTimingOffsetBeats: 0.05, maxVelocityOffset: 0 };
  const safe = { ...clip, notes: [clip.notes[0], { ...clip.notes[1], pitch: 64 }] };
  assert.deepEqual(planMidiHumanization(safe, options), planMidiHumanization(safe, options));
  assert.throws(() => planMidiHumanization(clip, options), /collision/);
  assert.throws(() => planMidiHumanization(clip, { ...options, noteIds: [] }), /non-empty/);
  assert.throws(() => planMidiHumanization(clip, { ...options, noteIds: [99] }), /unknown noteId/);
  assert.throws(() => planMidiHumanization(clip, { ...options, noteIds: [8, 8] }), /duplicate noteId/);
  assert.throws(() => planMidiHumanization(clip, { ...options,
    maxTimingOffsetBeats: 0.13 }), /half the grid/);
  assert.throws(() => planMidiHumanization(clip, { ...options,
    maxTimingOffsetBeats: 0, maxVelocityOffset: 0 }), /change timing or velocity/);
});

test("MIDI humanization readback rejects duplicated IDs that conceal a missing note", () => {
  const before = [note(7, 60, 0, 0.5, 100), note(8, 64, 1, 0.5, 90)];
  const changes = [{ noteId: 7, previous: before[0], start: 0.01, velocity: 101 }];
  const duplicated = [
    { ...before[0], start: 0.01, velocity: 101 },
    { ...before[0], start: 0.01, velocity: 101 },
  ];
  assert.equal(matchMidiHumanizationReadback(before, changes, duplicated), false);
});

function serviceFixture() {
  let applied = false;
  const notes = [
    note(7, 60, 0.01, 0.5, 100),
    note(8, 64, 2, 0.5, 90),
  ];
  const bridge = { async request(method, args) {
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: 4, trackId: args.trackId, clipId: args.clipId,
      lengthBeats: 4, notes,
    };
    if (method === "get_clip_timing") return {
      stateVersion: 4, trackId: args.trackId, clipId: args.clipId,
      lengthBeats: 4, loop: { startBeats: 0, endBeats: 4 },
    };
    if (method === "transform_midi_notes") {
      applied = true;
      const changes = new Map(args.changes.map(change => [change.noteId, change]));
      return { stateVersion: 6, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4,
        notes: notes.map(current => ({ ...current, ...changes.get(current.noteId) })) };
    }
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const originalCall = service.call.bind(service);
  service.call = async (name, args) => name === "get_song_grid_reference" ? {
    stateVersion: 4, setFingerprint: "set-1", tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
  } : originalCall(name, args);
  return { service, applied: () => applied };
}

const toolArgs = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: [7, 8],
  seed: 7, gridBeats: 0.25, maxTimingOffsetBeats: 0.05, maxVelocityOffset: 10 };

test("MCP humanization planning binds one exact clip, timing, and song grid", async () => {
  const { service } = serviceFixture();
  const result = await service.call("plan_midi_humanization", toolArgs);
  assert.equal(result.stateVersion, 4);
  assert.equal(result.plan.changes[0].velocity, 108);
  assert.equal(result.context.clipTiming.loop.endBeats, 4);
  assert.equal(result.context.gridReference.setFingerprint, "set-1");
});

test("guarded MIDI humanization verifies complete native note readback", async () => {
  const { service, applied } = serviceFixture();
  const args = { ...toolArgs, expectedStateVersion: 4 };
  const dry = await service.call("humanize_midi_notes", args);
  assert.equal(dry.plan.method, "transform_midi_notes");
  assert.equal(dry.plan.operation, "apply_midi_humanization");
  assert.equal(applied(), false);
  const live = await service.call("humanize_midi_notes", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 6);
  assert.equal(live.verification.matchesRequestedChanges, true);
  assert.equal(applied(), true);
});

test("MIDI humanization tools expose strict bounded contracts", () => {
  assert.equal(validateToolArguments("plan_midi_humanization", toolArgs).seed, 7);
  assert.equal(validateToolArguments("humanize_midi_notes", {
    ...toolArgs, expectedStateVersion: 4,
  }).maxVelocityOffset, 10);
  assert.throws(() => validateToolArguments("plan_midi_humanization", {
    ...toolArgs, mystery: true,
  }), /invalid tool arguments/);
});
