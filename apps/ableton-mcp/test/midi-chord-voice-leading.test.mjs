import test from "node:test";
import assert from "node:assert/strict";
import {
  matchMidiChordVoiceLeadingReadback,
  planMidiChordVoiceLeading,
} from "../src/midi-chord-voice-leading.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start) => ({
  noteId, pitch, start, duration: 1, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false,
});

const clip = {
  lengthBeats: 4,
  notes: [
    note(1, 60, 0), note(2, 64, 0), note(3, 67, 0), note(4, 71, 0),
    note(5, 53, 1), note(6, 57, 1), note(7, 60, 1), note(8, 64, 1),
  ],
};

test("all-voices mode minimizes literal octave movement from the anchored first chord", () => {
  const plan = planMidiChordVoiceLeading(clip, {
    noteIds: [1, 2, 3, 4, 5, 6, 7, 8], mode: "all_voices", minPitch: 48, maxPitch: 84,
  });
  assert.deepEqual(plan.changes.map(({ noteId, pitch }) => [noteId, pitch]), [
    [1, 60], [2, 64], [3, 67], [4, 71], [5, 65], [6, 69], [7, 72], [8, 76],
  ]);
  assert.equal(plan.totalMovementSemitones, 20);
});

test("preserve-bass mode locks each later bass while leading the upper voices", () => {
  const plan = planMidiChordVoiceLeading(clip, {
    noteIds: [1, 2, 3, 4, 5, 6, 7, 8], mode: "preserve_bass", minPitch: 48, maxPitch: 84,
  });
  assert.deepEqual(plan.changes.map(({ noteId, pitch }) => [noteId, pitch]), [
    [1, 60], [2, 64], [3, 67], [4, 71], [5, 53], [6, 69], [7, 72], [8, 76],
  ]);
  assert.equal(plan.totalMovementSemitones, 22);
});

test("voice leading rejects partial onsets, unequal voice counts, invalid ranges, and new collisions", () => {
  assert.throws(() => planMidiChordVoiceLeading(clip, {
    noteIds: [1, 2, 3, 4, 5, 6, 7], mode: "all_voices", minPitch: 48, maxPitch: 84,
  }), /complete onset/);
  const unequal = { ...clip, notes: clip.notes.filter(current => current.noteId !== 8) };
  assert.throws(() => planMidiChordVoiceLeading(unequal, {
    noteIds: unequal.notes.map(current => current.noteId), mode: "all_voices", minPitch: 48, maxPitch: 84,
  }), /same number of voices/);
  assert.throws(() => planMidiChordVoiceLeading(clip, {
    noteIds: clip.notes.map(current => current.noteId), mode: "all_voices", minPitch: 80, maxPitch: 70,
  }), /minPitch/);
  const collision = { ...clip, notes: [...clip.notes, note(9, 65, 1.5)] };
  assert.throws(() => planMidiChordVoiceLeading(collision, {
    noteIds: clip.notes.map(current => current.noteId), mode: "all_voices", minPitch: 48, maxPitch: 84,
  }), /collision/);
});

test("readback requires every non-pitch property and the complete note set", () => {
  const plan = planMidiChordVoiceLeading(clip, {
    noteIds: clip.notes.map(current => current.noteId), mode: "all_voices", minPitch: 48, maxPitch: 84,
  });
  const pitches = new Map(plan.changes.map(change => [change.noteId, change.pitch]));
  const observed = clip.notes.map(current => ({ ...current, pitch: pitches.get(current.noteId) }));
  assert.equal(matchMidiChordVoiceLeadingReadback(clip.notes, plan.changes, observed), true);
  assert.equal(matchMidiChordVoiceLeadingReadback(clip.notes, plan.changes,
    observed.map(current => current.noteId === 6 ? { ...current, probability: 1 } : current)), false);
  assert.equal(matchMidiChordVoiceLeadingReadback(clip.notes, plan.changes, observed.slice(1)), false);
});

function fixture() {
  let applied = false;
  const bridge = { async request(method, args) {
    if (method === "get_midi_clip_notes_extended") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId, ...clip,
    };
    if (method === "get_clip_timing") return {
      stateVersion: applied ? 5 : 4, trackId: args.trackId, clipId: args.clipId,
      loop: { enabled: true, startBeats: 0, endBeats: 4 },
    };
    if (method === "transform_midi_notes") {
      applied = true;
      const changes = new Map(args.changes.map(change => [change.noteId, change]));
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId,
        notes: clip.notes.map(current => ({ ...current, pitch: changes.get(current.noteId)?.pitch ?? current.pitch })) };
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

const args = { trackId: "track-0", clipId: "track-0:clip-0",
  noteIds: [1, 2, 3, 4, 5, 6, 7, 8], mode: "all_voices", minPitch: 48, maxPitch: 84 };

test("guarded chord voice leading binds context and verifies complete native readback", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_chord_voice_leading", args);
  assert.equal(planned.plan.totalMovementSemitones, 20);
  const dry = await service.call("apply_midi_chord_voice_leading", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_chord_voice_leading", { ...args, expectedStateVersion: 4, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
});

test("chord voice-leading tools expose strict bounded contracts", () => {
  assert.equal(validateToolArguments("plan_midi_chord_voice_leading", args).mode, "all_voices");
  assert.throws(() => validateToolArguments("plan_midi_chord_voice_leading", { ...args, mode: "free" }),
    /invalid tool arguments/);
  assert.throws(() => validateToolArguments("apply_midi_chord_voice_leading", { ...args, minPitch: 85 }),
    /invalid tool arguments/);
});
