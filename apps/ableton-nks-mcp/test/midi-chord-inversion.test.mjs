import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiChordInversionReadback, planMidiChordInversion } from "../src/midi-chord-inversion.mjs";
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

test("chord inversion rotates exact complete onsets up or down by octaves", () => {
  assert.deepEqual(planMidiChordInversion(clip, {
    noteIds: [1, 2, 3], direction: "up", steps: 1,
  }).changes.map(({ noteId, pitch }) => ({ noteId, pitch })), [
    { noteId: 2, pitch: 72 }, { noteId: 3, pitch: 64 }, { noteId: 1, pitch: 67 },
  ]);
  assert.deepEqual(planMidiChordInversion(clip, {
    noteIds: [1, 2, 3], direction: "up", steps: 2,
  }).changes.map(({ noteId, pitch }) => ({ noteId, pitch })), [
    { noteId: 2, pitch: 72 }, { noteId: 3, pitch: 76 }, { noteId: 1, pitch: 67 },
  ]);
  assert.deepEqual(planMidiChordInversion(clip, {
    noteIds: [1, 2, 3], direction: "down", steps: 1,
  }).changes.map(({ noteId, pitch }) => ({ noteId, pitch })), [
    { noteId: 2, pitch: 60 }, { noteId: 3, pitch: 64 }, { noteId: 1, pitch: 55 },
  ]);
  assert.deepEqual(planMidiChordInversion(clip, {
    noteIds: [1, 2, 3], direction: "up", steps: 3,
  }).changes.map(({ noteId, pitch }) => ({ noteId, pitch })), [
    { noteId: 2, pitch: 72 }, { noteId: 3, pitch: 76 }, { noteId: 1, pitch: 79 },
  ]);
});

test("chord inversion applies independently to multiple complete onsets", () => {
  const plan = planMidiChordInversion(clip, {
    noteIds: [1, 2, 3, 4, 5, 6], direction: "down", steps: 2,
  });
  assert.deepEqual(plan.changes.map(({ noteId, pitch }) => ({ noteId, pitch })), [
    { noteId: 2, pitch: 60 }, { noteId: 3, pitch: 52 }, { noteId: 1, pitch: 55 },
    { noteId: 4, pitch: 60 }, { noteId: 6, pitch: 52 }, { noteId: 5, pitch: 55 },
  ]);
});

test("chord inversion rejects partial onsets, non-chords, range overflow, and new collisions", () => {
  assert.throws(() => planMidiChordInversion(clip, {
    noteIds: [1, 2], direction: "up", steps: 1,
  }), /complete onset/);
  assert.throws(() => planMidiChordInversion({ lengthBeats: 4, notes: [note(1, 60, 0)] }, {
    noteIds: [1], direction: "up", steps: 1,
  }), /at least two notes/);
  assert.throws(() => planMidiChordInversion({ lengthBeats: 4, notes: [note(1, 120, 0), note(2, 124, 0)] }, {
    noteIds: [1, 2], direction: "up", steps: 1,
  }), /MIDI pitch range/);
  assert.throws(() => planMidiChordInversion({ lengthBeats: 4, notes: [
    note(1, 60, 0), note(2, 64, 0), note(3, 72, 0.5),
  ] }, { noteIds: [1, 2], direction: "up", steps: 1 }), /collision/);
});

test("chord inversion readback preserves timing and every non-pitch property", () => {
  const plan = planMidiChordInversion(clip, {
    noteIds: [1, 2, 3], direction: "up", steps: 1,
  });
  const byId = new Map(plan.changes.map(change => [change.noteId, change]));
  const observed = clip.notes.map(current => ({ ...current,
    pitch: byId.get(current.noteId)?.pitch ?? current.pitch,
  }));
  assert.equal(matchMidiChordInversionReadback(clip.notes, plan.changes, observed), true);
  assert.equal(matchMidiChordInversionReadback(clip.notes, plan.changes, observed.map(current =>
    current.noteId === 2 ? { ...current, probability: 1 } : current)), false);
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
          pitch: byId.get(current.noteId)?.pitch ?? current.pitch,
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
  noteIds: [1, 2, 3], direction: "up", steps: 1 };

test("MCP chord inversion planning binds exact clip, timing, and song grid", async () => {
  const { service } = serviceFixture();
  const result = await service.call("plan_midi_chord_inversion", toolArgs);
  assert.equal(result.stateVersion, 4);
  assert.equal(result.plan.changes[0].pitch, 72);
  assert.equal(result.context.clipTiming.loop.endBeats, 4);
  assert.equal(result.context.gridReference.setFingerprint, "set-1");
});

test("guarded chord inversion verifies complete native readback", async () => {
  const { service, applied } = serviceFixture();
  const args = { ...toolArgs, expectedStateVersion: 4 };
  const dry = await service.call("apply_midi_chord_inversion", args);
  assert.equal(dry.plan.operation, "apply_midi_chord_inversion");
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_chord_inversion", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(live.verification.matchesExpectedNotes, true);
  assert.equal(applied(), true);
});

test("chord inversion tools expose strict bounded contracts", () => {
  assert.equal(validateToolArguments("plan_midi_chord_inversion", toolArgs).steps, 1);
  assert.equal(validateToolArguments("apply_midi_chord_inversion", {
    ...toolArgs, expectedStateVersion: 4,
  }).direction, "up");
  assert.throws(() => validateToolArguments("plan_midi_chord_inversion", {
    ...toolArgs, direction: "inside-out",
  }), /invalid tool arguments/);
});
