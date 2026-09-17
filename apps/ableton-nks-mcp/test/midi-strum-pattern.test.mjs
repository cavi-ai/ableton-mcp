import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiStrumReadback, planMidiStrumPattern } from "../src/midi-strum-pattern.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start, duration = 1) => ({
  noteId, pitch, start, duration, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});

const clip = { lengthBeats: 4, notes: [
  note(1, 67, 0), note(2, 60, 0), note(3, 64, 0),
  note(4, 60, 2), note(5, 67, 2), note(6, 64, 2),
] };

test("strum pattern orders complete chords up, down, and alternating while preserving note ends", () => {
  const up = planMidiStrumPattern(clip, {
    noteIds: [1, 2, 3], direction: "up", spreadBeats: 0.12,
  });
  assert.deepEqual(up.changes.map(({ noteId, start, duration }) => ({ noteId, start, duration })), [
    { noteId: 2, start: 0, duration: 1 },
    { noteId: 3, start: 0.06, duration: 0.94 },
    { noteId: 1, start: 0.12, duration: 0.88 },
  ]);
  assert.deepEqual(planMidiStrumPattern(clip, {
    noteIds: [1, 2, 3], direction: "down", spreadBeats: 0.12,
  }).changes.map(({ noteId, start }) => ({ noteId, start })), [
    { noteId: 1, start: 0 }, { noteId: 3, start: 0.06 }, { noteId: 2, start: 0.12 },
  ]);
  assert.deepEqual(planMidiStrumPattern(clip, {
    noteIds: [1, 2, 3, 4, 5, 6], direction: "alternating", spreadBeats: 0.12,
  }).changes.map(({ noteId, start }) => ({ noteId, start })), [
    { noteId: 2, start: 0 }, { noteId: 3, start: 0.06 }, { noteId: 1, start: 0.12 },
    { noteId: 5, start: 2 }, { noteId: 6, start: 2.06 }, { noteId: 4, start: 2.12 },
  ]);
});

test("strum planning rejects incomplete chords, collapsed notes, and non-chords", () => {
  assert.throws(() => planMidiStrumPattern(clip, {
    noteIds: [1, 2], direction: "up", spreadBeats: 0.12,
  }), /complete onset/);
  assert.throws(() => planMidiStrumPattern({ ...clip, notes: [
    note(1, 60, 0, 0.05), note(2, 64, 0, 0.05), note(3, 67, 0, 0.05),
  ] }, { noteIds: [1, 2, 3], direction: "up", spreadBeats: 0.12 }), /positive duration/);
  assert.throws(() => planMidiStrumPattern({ lengthBeats: 4, notes: [note(1, 60, 0)] }, {
    noteIds: [1], direction: "up", spreadBeats: 0.12,
  }), /at least two notes/);
});

test("strum readback preserves every non-timing property and unrelated note", () => {
  const before = { ...clip, notes: [...clip.notes, note(7, 72, 3, 0.5)] };
  const plan = planMidiStrumPattern(before, {
    noteIds: [1, 2, 3], direction: "up", spreadBeats: 0.12,
  });
  const byId = new Map(plan.changes.map(change => [change.noteId, change]));
  const observed = before.notes.map(current => ({ ...current,
    start: byId.get(current.noteId)?.start ?? current.start,
    duration: byId.get(current.noteId)?.duration ?? current.duration,
  }));
  assert.equal(matchMidiStrumReadback(before.notes, plan.changes, observed), true);
  assert.equal(matchMidiStrumReadback(before.notes, plan.changes, observed.map(current =>
    current.noteId === 3 ? { ...current, releaseVelocity: 63 } : current)), false);
});

function serviceFixture() {
  let applied = false;
  const bridge = { async request(method, args) {
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId, ...clip,
    };
    if (method === "get_clip_timing") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId,
      loop: { enabled: true, startBeats: 0, endBeats: 4 },
      timeSignature: { numerator: 4, denominator: 4 },
    };
    if (method === "transform_midi_notes") {
      applied = true;
      const byId = new Map(args.changes.map(change => [change.noteId, change]));
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId,
        notes: clip.notes.map(current => ({ ...current,
          start: byId.get(current.noteId)?.start ?? current.start,
          duration: byId.get(current.noteId)?.duration ?? current.duration,
        })) };
    }
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const originalCall = service.call.bind(service);
  service.call = async (name, args) => name === "get_song_grid_reference" ? {
    stateVersion: applied ? 5 : 4, setFingerprint: "set-1", tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
  } : originalCall(name, args);
  return { service, applied: () => applied };
}

const toolArgs = { trackId: "track-0", clipId: "track-0:clip-0",
  noteIds: [1, 2, 3, 4, 5, 6], direction: "alternating", spreadBeats: 0.12 };

test("MCP strum planning binds exact clip, timing, and song grid", async () => {
  const { service } = serviceFixture();
  const result = await service.call("plan_midi_strum_pattern", toolArgs);
  assert.equal(result.stateVersion, 4);
  assert.equal(result.plan.changes.length, 6);
  assert.equal(result.context.clipTiming.loop.endBeats, 4);
  assert.equal(result.context.gridReference.setFingerprint, "set-1");
});

test("guarded strum application verifies complete native readback", async () => {
  const { service, applied } = serviceFixture();
  const args = { ...toolArgs, expectedStateVersion: 4 };
  const dry = await service.call("apply_midi_strum_pattern", args);
  assert.equal(dry.plan.operation, "apply_midi_strum_pattern");
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_strum_pattern", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("strum tools expose strict bounded contracts", () => {
  assert.equal(validateToolArguments("plan_midi_strum_pattern", toolArgs).direction, "alternating");
  assert.equal(validateToolArguments("apply_midi_strum_pattern", {
    ...toolArgs, expectedStateVersion: 4,
  }).spreadBeats, 0.12);
  assert.throws(() => validateToolArguments("plan_midi_strum_pattern", {
    ...toolArgs, direction: "random",
  }), /invalid tool arguments/);
});
