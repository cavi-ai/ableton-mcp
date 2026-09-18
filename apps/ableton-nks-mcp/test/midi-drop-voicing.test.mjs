import test from "node:test";
import assert from "node:assert/strict";
import { matchMidiDropVoicingReadback, planMidiDropVoicing } from "../src/midi-drop-voicing.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { validateToolArguments } from "../src/tool-validation.mjs";

const note = (noteId, pitch, start = 0) => ({ noteId, pitch, start, duration: 1, velocity: 91,
  velocityDeviation: -3, releaseVelocity: 62, probability: 0.75, mute: false });
const clip = { lengthBeats: 4, notes: [note(1, 60), note(2, 64), note(3, 67), note(4, 71)] };

test("drop voicing lowers literal upper voices for drop-2, drop-3, and drop-2-and-4", () => {
  const pitches = mode => planMidiDropVoicing(clip, { noteIds: [1, 2, 3, 4], mode })
    .changes.map(({ noteId, pitch }) => [noteId, pitch]);
  assert.deepEqual(pitches("drop_2"), [[1, 60], [2, 64], [3, 55], [4, 71]]);
  assert.deepEqual(pitches("drop_3"), [[1, 60], [2, 52], [3, 67], [4, 71]]);
  assert.deepEqual(pitches("drop_2_and_4"), [[1, 48], [2, 64], [3, 55], [4, 71]]);
});

test("drop voicing rejects incomplete, undersized, out-of-range, and colliding chords", () => {
  assert.throws(() => planMidiDropVoicing(clip, { noteIds: [1, 2, 3], mode: "drop_2" }), /complete onset/);
  assert.throws(() => planMidiDropVoicing({ lengthBeats: 4, notes: [note(1, 60), note(2, 64)] },
    { noteIds: [1, 2], mode: "drop_2" }), /at least three/);
  assert.throws(() => planMidiDropVoicing({ lengthBeats: 4, notes: [note(1, 0), note(2, 4), note(3, 7)] },
    { noteIds: [1, 2, 3], mode: "drop_2" }), /MIDI pitch range/);
  assert.throws(() => planMidiDropVoicing({ lengthBeats: 4, notes: [note(1, 60), note(2, 64), note(3, 67), note(4, 52, 0.5)] },
    { noteIds: [1, 2, 3], mode: "drop_2" }), /collision/);
});

test("drop voicing readback preserves all non-pitch state", () => {
  const plan = planMidiDropVoicing(clip, { noteIds: [1, 2, 3, 4], mode: "drop_2" });
  const changes = new Map(plan.changes.map(change => [change.noteId, change]));
  const observed = clip.notes.map(note => ({ ...note, pitch: changes.get(note.noteId)?.pitch ?? note.pitch }));
  assert.equal(matchMidiDropVoicingReadback(clip.notes, plan.changes, observed), true);
  assert.equal(matchMidiDropVoicingReadback(clip.notes, plan.changes,
    observed.map(note => note.noteId === 3 ? { ...note, probability: 1 } : note)), false);
});

function fixture() {
  let applied = false;
  const bridge = { async request(method, args) {
    if (method === "get_midi_clip_notes_extended") return { stateVersion: applied ? 5 : 4,
      trackId: args.trackId, clipId: args.clipId, ...clip };
    if (method === "get_clip_timing") return { stateVersion: applied ? 5 : 4,
      trackId: args.trackId, clipId: args.clipId, loop: { enabled: true, startBeats: 0, endBeats: 4 } };
    if (method === "transform_midi_notes") { applied = true; const changes = new Map(args.changes.map(c => [c.noteId, c]));
      return { stateVersion: 5, trackId: args.trackId, clipId: args.clipId,
        notes: clip.notes.map(note => ({ ...note, pitch: changes.get(note.noteId)?.pitch ?? note.pitch })) }; }
    throw new Error(`unexpected ${method}`);
  } };
  const service = new ToolService({ bridge, catalog: {} });
  const call = service.call.bind(service);
  service.call = async (name, args) => name === "get_song_grid_reference" ? { stateVersion: applied ? 5 : 4,
    setFingerprint: "set-1", tempoBpm: 120, timeSignature: { numerator: 4, denominator: 4 } } : call(name, args);
  return { service, applied: () => applied };
}
const args = { trackId: "track-0", clipId: "track-0:clip-0", noteIds: [1, 2, 3, 4], mode: "drop_2" };

test("guarded drop voicing binds context and verifies complete native readback", async () => {
  const { service, applied } = fixture();
  const planned = await service.call("plan_midi_drop_voicing", args);
  assert.equal(planned.plan.changes[2].pitch, 55);
  const dry = await service.call("apply_midi_drop_voicing", { ...args, expectedStateVersion: 4 });
  assert.equal(applied(), false);
  const live = await service.call("apply_midi_drop_voicing", { ...args, expectedStateVersion: 4, dryRun: false,
    confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
  assert.equal(live.verification.matchesExpectedNotes, true);
});

test("drop voicing tools expose strict contracts", () => {
  assert.equal(validateToolArguments("plan_midi_drop_voicing", args).mode, "drop_2");
  assert.throws(() => validateToolArguments("plan_midi_drop_voicing", { ...args, mode: "open" }), /invalid tool arguments/);
});
