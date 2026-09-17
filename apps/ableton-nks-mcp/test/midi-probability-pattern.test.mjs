import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiProbabilityPatternReadback, planMidiProbabilityPattern } from "../src/midi-probability-pattern.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start, probability = 1) => ({
  noteId, pitch, start, duration: 0.5, velocity: 90,
  velocityDeviation: 0, releaseVelocity: 64, probability, mute: false,
});

const clip = { lengthBeats: 4, notes: [
  note(1, 60, 0), note(2, 64, 0), note(3, 67, 1), note(4, 72, 2),
] };

test("probability pattern assigns one explicit value per ordered complete onset", () => {
  const plan = planMidiProbabilityPattern(clip, {
    noteIds: [1, 2, 3, 4], probabilities: [1, 0.5, 0],
  });
  assert.deepEqual(plan.changes.map(({ noteId, probability }) => ({ noteId, probability })), [
    { noteId: 3, probability: 0.5 }, { noteId: 4, probability: 0 },
  ]);
  assert.deepEqual(plan.probabilities, [1, 0.5, 0]);
});

test("probability planning rejects ambiguous, malformed, and no-op selections", () => {
  assert.throws(() => planMidiProbabilityPattern(clip, {
    noteIds: [1, 3, 4], probabilities: [0.5],
  }), /complete onset/);
  assert.throws(() => planMidiProbabilityPattern(clip, {
    noteIds: [1, 1], probabilities: [0.5],
  }), /duplicate noteId/);
  assert.throws(() => planMidiProbabilityPattern(clip, {
    noteIds: [99], probabilities: [0.5],
  }), /unknown noteId/);
  assert.throws(() => planMidiProbabilityPattern(clip, {
    noteIds: [1, 2, 3, 4], probabilities: [1.1],
  }), /probabilities\[0\].*between 0 and 1/);
  assert.throws(() => planMidiProbabilityPattern(clip, {
    noteIds: [1, 2, 3, 4], probabilities: [1],
  }), /would not change/);
});

test("probability readback requires every note and preserves non-probability fields", () => {
  const plan = planMidiProbabilityPattern(clip, {
    noteIds: [1, 2, 3, 4], probabilities: [0.75],
  });
  const targets = new Map(plan.changes.map(change => [change.noteId, change.probability]));
  const observed = clip.notes.map(current => ({
    ...current, probability: targets.get(current.noteId) ?? current.probability,
  }));
  assert.equal(matchMidiProbabilityPatternReadback(clip.notes, plan.changes, observed), true);
  assert.equal(matchMidiProbabilityPatternReadback(clip.notes, plan.changes, [
    { ...observed[0], duration: 0.25 }, ...observed.slice(1),
  ]), false);
  assert.equal(matchMidiProbabilityPatternReadback(clip.notes, plan.changes, observed.slice(1)), false);
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
        notes: clip.notes.map(current => ({ ...current,
          probability: changes.get(current.noteId)?.probability ?? current.probability })) };
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

const toolArgs = { trackId: "track-0", clipId: "track-0:clip-0",
  noteIds: [1, 2, 3, 4], probabilities: [1, 0.5, 0] };

test("MCP probability planning binds exact clip, timing, and set context", async () => {
  const { service } = serviceFixture();
  const result = await service.call("plan_midi_probability_pattern", toolArgs);
  assert.equal(result.stateVersion, 4);
  assert.deepEqual(result.plan.changes.map(change => change.probability), [0.5, 0]);
  assert.equal(result.context.clipTiming.loop.endBeats, 4);
  assert.equal(result.context.gridReference.setFingerprint, "set-1");
});

test("guarded probability application verifies complete native readback", async () => {
  const { service, applied } = serviceFixture();
  const args = { ...toolArgs, expectedStateVersion: 4 };
  const dry = await service.call("apply_midi_probability_pattern", args);
  assert.equal(dry.plan.operation, "apply_midi_probability_pattern");
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_probability_pattern", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(live.verification.matchesRequestedChanges, true);
  assert.equal(applied(), true);
});

test("probability tools expose strict explicit-pattern contracts", () => {
  assert.deepEqual(validateToolArguments("plan_midi_probability_pattern", toolArgs).probabilities, [1, 0.5, 0]);
  assert.deepEqual(validateToolArguments("apply_midi_probability_pattern", {
    ...toolArgs, expectedStateVersion: 4,
  }).noteIds, [1, 2, 3, 4]);
  assert.throws(() => validateToolArguments("plan_midi_probability_pattern", {
    ...toolArgs, probabilities: [-0.1],
  }), /invalid tool arguments/);
});
