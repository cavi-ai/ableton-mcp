import test from "node:test";
import assert from "node:assert/strict";
import { buildSerumPreviewMidi } from "../src/preview-midi.mjs";

test("buildSerumPreviewMidi emits a type-0 12-second phrase at 120 BPM", () => {
  const midi = buildSerumPreviewMidi();
  assert.equal(midi.subarray(0, 4).toString("ascii"), "MThd");
  assert.equal(midi.readUInt16BE(8), 0);
  assert.equal(midi.readUInt16BE(12), 480);
  assert.equal(midi.includes(Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])), true);
  assert.equal(midi.includes(Buffer.from([0x90, 48, 96])), true);
  assert.equal(midi.subarray(-3).equals(Buffer.from([0xff, 0x2f, 0x00])), true);
});
