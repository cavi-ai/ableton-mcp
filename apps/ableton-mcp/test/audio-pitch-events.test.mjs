import test from "node:test";
import assert from "node:assert/strict";
import { segmentPitchEvents } from "../src/audio-pitch-events.mjs";

test("pitch events separate stable notes across unvoiced frames and discard single-frame glitches", () => {
  const frame = (startSeconds, midiNote, noteName, centsFromNote) => ({
    startSeconds, endSeconds: startSeconds + 0.256,
    estimate: midiNote === null ? null : { periodicityConfidence: 0.95,
      pitchReference: { midiNote, noteName, centsFromNote } }
  });
  const frames = [frame(0, 69, "A4", 10), frame(0.128, 69, "A4", 20),
    frame(0.256, null), frame(0.384, 81, "A5", -5), frame(0.512, 81, "A5", -7),
    frame(0.64, 57, "A3", 0)];
  const result = segmentPitchEvents(frames);
  assert.equal(result.unvoicedFrameCount, 1);
  assert.equal(result.discardedShortRuns, 1);
  assert.deepEqual(result.events.map(({ midiNote, noteName, medianCentsFromNote, voicedFrames }) =>
    ({ midiNote, noteName, medianCentsFromNote, voicedFrames })), [
    { midiNote: 69, noteName: "A4", medianCentsFromNote: 15, voicedFrames: 2 },
    { midiNote: 81, noteName: "A5", medianCentsFromNote: -6, voicedFrames: 2 }
  ]);
  assert.equal(result.events[0].startSeconds, 0);
  assert.ok(Math.abs(result.events[0].endSeconds - 0.32) < 1e-9);
  assert.ok(Math.abs(result.events[1].startSeconds - 0.448) < 1e-9);
  assert.ok(Math.abs(result.events[1].endSeconds - 0.704) < 1e-9);
});

test("pitch event segmentation rejects frames with backwards centers", () => {
  const estimate = { pitchReference: { midiNote: 69, noteName: "A4", centsFromNote: 0 } };
  assert.throws(() => segmentPitchEvents([
    { startSeconds: 0, endSeconds: 1, estimate },
    { startSeconds: 0.1, endSeconds: 0.2, estimate }
  ]), /increasing/);
});
