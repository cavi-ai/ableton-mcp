import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiGatePatternReadback, planMidiGatePattern } from "../src/midi-gate-pattern.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start, duration = 0.5) => ({
  noteId, pitch, start, duration, velocity: 90,
  velocityDeviation: 0, releaseVelocity: 64, probability: 1, mute: false,
});

const clip = { lengthBeats: 4, notes: [
  note(1, 60, 0), note(2, 64, 0), note(3, 67, 1), note(4, 72, 2),
] };

test("gate pattern assigns one explicit duration per ordered complete onset", () => {
  const plan = planMidiGatePattern(clip, {
    noteIds: [1, 2, 3, 4], gridBeats: 1, gateRatios: [0.5, 0.9],
  });
  assert.deepEqual(plan.changes.map(({ noteId, duration }) => ({ noteId, duration })), [
    { noteId: 3, duration: 0.9 },
  ]);
  assert.deepEqual(plan.gateRatios, [0.5, 0.9]);
});

test("gate planning rejects partial onsets, boundary violations, collisions, and no-ops", () => {
  assert.throws(() => planMidiGatePattern(clip, {
    noteIds: [1, 3, 4], gridBeats: 1, gateRatios: [0.5],
  }), /complete onset/);
  assert.throws(() => planMidiGatePattern(clip, {
    noteIds: [4], gridBeats: 2, gateRatios: [1.1],
  }), /gateRatios\[0\].*greater than 0 and at most 1/);
  assert.throws(() => planMidiGatePattern({ lengthBeats: 4, notes: [
    note(1, 60, 0, 0.25), note(2, 60, 0.75, 0.25),
  ] }, { noteIds: [1], gridBeats: 1, gateRatios: [1] }), /same-pitch collision/);
  assert.throws(() => planMidiGatePattern(clip, {
    noteIds: [4], gridBeats: 4, gateRatios: [1],
  }), /beyond the clip/);
  assert.throws(() => planMidiGatePattern(clip, {
    noteIds: [1, 2, 3, 4], gridBeats: 1, gateRatios: [0.5],
  }), /would not change/);
});

test("an unrelated existing overlap cannot hide a newly introduced collision", () => {
  const notes = [
    note(1, 62, 0, 1), note(2, 62, 0.5, 1),
    note(3, 60, 2, 0.25), note(4, 60, 2.75, 0.25),
  ];
  assert.throws(() => planMidiGatePattern({ lengthBeats: 4, notes }, {
    noteIds: [3], gridBeats: 1, gateRatios: [1],
  }), /same-pitch collision/);
});

test("gate readback requires the complete note set and only requested durations", () => {
  const plan = planMidiGatePattern(clip, {
    noteIds: [1, 2, 3, 4], gridBeats: 1, gateRatios: [0.75],
  });
  const durations = new Map(plan.changes.map(change => [change.noteId, change.duration]));
  const observed = clip.notes.map(current => ({
    ...current, duration: durations.get(current.noteId) ?? current.duration,
  }));
  assert.equal(matchMidiGatePatternReadback(clip.notes, plan.changes, observed), true);
  assert.equal(matchMidiGatePatternReadback(clip.notes, plan.changes, [
    { ...observed[0], velocity: 91 }, ...observed.slice(1),
  ]), false);
  assert.equal(matchMidiGatePatternReadback(clip.notes, plan.changes, observed.slice(1)), false);
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
          duration: changes.get(current.noteId)?.duration ?? current.duration })) };
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
  noteIds: [1, 2, 3, 4], gridBeats: 1, gateRatios: [0.75] };

test("MCP gate planning binds exact clip, timing, and set context", async () => {
  const { service } = serviceFixture();
  const result = await service.call("plan_midi_gate_pattern", toolArgs);
  assert.equal(result.stateVersion, 4);
  assert.equal(result.plan.changes.length, 4);
  assert.equal(result.context.clipTiming.loop.endBeats, 4);
  assert.equal(result.context.gridReference.setFingerprint, "set-1");
});

test("guarded gate application verifies complete native readback", async () => {
  const { service, applied } = serviceFixture();
  const args = { ...toolArgs, expectedStateVersion: 4 };
  const dry = await service.call("apply_midi_gate_pattern", args);
  assert.equal(dry.plan.operation, "apply_midi_gate_pattern");
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_gate_pattern", { ...args, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.observed.stateVersion, 5);
  assert.equal(live.verification.matchesRequestedChanges, true);
  assert.equal(applied(), true);
});

test("gate tools expose strict explicit-ratio contracts", () => {
  assert.deepEqual(validateToolArguments("plan_midi_gate_pattern", toolArgs).gateRatios, [0.75]);
  assert.equal(validateToolArguments("apply_midi_gate_pattern", {
    ...toolArgs, expectedStateVersion: 4,
  }).gridBeats, 1);
  assert.throws(() => validateToolArguments("plan_midi_gate_pattern", {
    ...toolArgs, gateRatios: [0],
  }), /invalid tool arguments/);
});
