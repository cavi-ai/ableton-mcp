import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiVelocityCurveReadback, planMidiVelocityCurve } from "../src/midi-velocity-curve.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start, velocity) => ({
  noteId, pitch, start, duration: 0.5, velocity,
  velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false,
});

const clip = { lengthBeats: 4, notes: [
  note(1, 60, 0, 70), note(2, 64, 0, 80),
  note(3, 67, 1, 90), note(4, 72, 2, 100),
] };

test("crescendo assigns one hand-derived velocity per ordered onset", () => {
  const plan = planMidiVelocityCurve(clip, {
    noteIds: [1, 2, 3, 4], curve: { type: "crescendo", startVelocity: 60, endVelocity: 120 },
  });
  assert.deepEqual(plan.changes.map(({ noteId, velocity }) => ({ noteId, velocity })), [
    { noteId: 1, velocity: 60 }, { noteId: 2, velocity: 60 },
    { noteId: 4, velocity: 120 },
  ]);
});

test("decrescendo, fixed, and repeating accent curves produce literal targets", () => {
  const decrescendo = planMidiVelocityCurve(clip, {
    noteIds: [1, 2, 3, 4], curve: { type: "decrescendo", startVelocity: 120, endVelocity: 60 },
  });
  assert.deepEqual(decrescendo.changes.map(change => change.velocity), [120, 120, 60]);
  const fixed = planMidiVelocityCurve(clip, {
    noteIds: [1, 2, 3, 4], curve: { type: "fixed", velocity: 88 },
  });
  assert.deepEqual(fixed.changes.map(change => change.velocity), [88, 88, 88, 88]);
  const accent = planMidiVelocityCurve(clip, {
    noteIds: [1, 2, 3, 4], curve: { type: "accent", velocities: [110, 75] },
  });
  assert.deepEqual(accent.changes.map(change => change.velocity), [110, 110, 75, 110]);
});

test("velocity planning rejects ambiguous, malformed, and no-op selections", () => {
  assert.throws(() => planMidiVelocityCurve(clip, {
    noteIds: [1, 3, 4], curve: { type: "fixed", velocity: 80 },
  }), /complete onset/);
  assert.throws(() => planMidiVelocityCurve(clip, {
    noteIds: [1, 1], curve: { type: "fixed", velocity: 80 },
  }), /duplicate noteId/);
  assert.throws(() => planMidiVelocityCurve(clip, {
    noteIds: [99], curve: { type: "fixed", velocity: 80 },
  }), /unknown noteId/);
  assert.throws(() => planMidiVelocityCurve(clip, {
    noteIds: [1, 2, 3, 4], curve: { type: "crescendo", startVelocity: 100, endVelocity: 80 },
  }), /greater than/);
  assert.throws(() => planMidiVelocityCurve(clip, {
    noteIds: [1, 2, 3, 4], curve: { type: "accent", velocities: [] },
  }), /non-empty/);
  assert.throws(() => planMidiVelocityCurve({ ...clip, notes: clip.notes.map(current => ({ ...current, velocity: 88 })) }, {
    noteIds: [1, 2, 3, 4], curve: { type: "fixed", velocity: 88 },
  }), /would not change/);
});

test("velocity readback requires every note and preserves non-velocity fields", () => {
  const plan = planMidiVelocityCurve(clip, {
    noteIds: [1, 2, 3, 4], curve: { type: "fixed", velocity: 88 },
  });
  const observed = clip.notes.map(current => ({ ...current, velocity: 88 }));
  assert.equal(matchMidiVelocityCurveReadback(clip.notes, plan.changes, observed), true);
  assert.equal(matchMidiVelocityCurveReadback(clip.notes, plan.changes, [
    { ...observed[0], pitch: 61 }, ...observed.slice(1),
  ]), false);
  assert.equal(matchMidiVelocityCurveReadback(clip.notes, plan.changes, [
    observed[0], observed[0], ...observed.slice(2),
  ]), false);
});

function serviceFixture() {
  let applied = false;
  const bridge = { async request(method, args) {
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: 4, trackId: args.trackId, clipId: args.clipId, ...clip,
    };
    if (method === "get_clip_timing") return {
      stateVersion: 4, trackId: args.trackId, clipId: args.clipId,
      lengthBeats: 4, loop: { startBeats: 0, endBeats: 4 },
    };
    if (method === "transform_midi_notes") {
      applied = true;
      const changes = new Map(args.changes.map(change => [change.noteId, change]));
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId, lengthBeats: 4,
        notes: clip.notes.map(current => ({ ...current, velocity: changes.get(current.noteId)?.velocity ?? current.velocity })) };
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

const toolArgs = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: [1, 2, 3, 4],
  curve: { type: "crescendo", startVelocity: 60, endVelocity: 120 } };

test("MCP velocity planning binds the exact clip, timing, and set context", async () => {
  const { service } = serviceFixture();
  const result = await service.call("plan_midi_velocity_curve", toolArgs);
  assert.equal(result.stateVersion, 4);
  assert.deepEqual(result.plan.changes.map(({ noteId, velocity }) => ({ noteId, velocity })), [
    { noteId: 1, velocity: 60 }, { noteId: 2, velocity: 60 }, { noteId: 4, velocity: 120 },
  ]);
  assert.equal(result.context.clipTiming.loop.endBeats, 4);
  assert.equal(result.context.gridReference.setFingerprint, "set-1");
});

test("guarded velocity application verifies the complete native readback", async () => {
  const { service, applied } = serviceFixture();
  const args = { ...toolArgs, expectedStateVersion: 4 };
  const dry = await service.call("apply_midi_velocity_curve", args);
  assert.equal(dry.plan.operation, "apply_midi_velocity_curve");
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_velocity_curve", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(live.verification.matchesRequestedChanges, true);
  assert.equal(applied(), true);
});

test("velocity-curve tools expose strict mode-specific contracts", () => {
  assert.equal(validateToolArguments("plan_midi_velocity_curve", toolArgs).curve.type, "crescendo");
  assert.equal(validateToolArguments("apply_midi_velocity_curve", {
    ...toolArgs, expectedStateVersion: 4,
  }).curve.endVelocity, 120);
  assert.throws(() => validateToolArguments("plan_midi_velocity_curve", {
    ...toolArgs, curve: { type: "fixed", velocity: 88, endVelocity: 120 },
  }), /invalid tool arguments/);
});
