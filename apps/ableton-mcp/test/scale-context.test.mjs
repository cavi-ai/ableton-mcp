import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { getLiveScaleReference, listLiveScaleReferences } from "../src/live-scale-reference.mjs";

test("Live scale reference resolves intervals, pitch classes, and degrees from an exact root", () => {
  assert.deepEqual(getLiveScaleReference("Dorian", 2), {
    name: "Dorian",
    family: "major-mode",
    intervals: [0, 2, 3, 5, 7, 9, 10],
    rootNote: 2,
    rootName: "D",
    pitchClasses: [2, 4, 5, 7, 9, 11, 0],
    noteNames: ["D", "E", "F", "G", "A", "B", "C"],
    degrees: [1, 2, 3, 4, 5, 6, 7]
  });
});

test("Live scale catalog includes diatonic, symmetric, pentatonic, world, and Messiaen scales", () => {
  const scales = listLiveScaleReferences();
  for (const name of ["Major", "Minor", "Half-whole Dim.", "Minor Pentatonic", "Bhairav", "Messiaen 7"])
    assert.equal(scales.some(scale => scale.name === name), true, name);
  assert.equal(new Set(scales.map(scale => scale.name)).size, scales.length);
  assert.equal(scales.every(scale => scale.intervals[0] === 0), true);
});

test("scale reference rejects unknown names and invalid roots", () => {
  assert.throws(() => getLiveScaleReference("Made Up", 0), /unknown Live scale/);
  assert.throws(() => getLiveScaleReference("Major", 12), /rootNote/);
});

test("scale reference is exposed as a read-only MCP tool", async () => {
  const service = { async call(name, args) {
    assert.equal(name, "get_live_scale_reference");
    assert.deepEqual(args, { scaleName: "Minor", rootNote: 9 });
    return { scale: getLiveScaleReference(args.scaleName, args.rootNote) };
  } };
  const reply = await createRouter(service)({ id: 1, method: "tools/call", params: {
    name: "get_live_scale_reference", arguments: { scaleName: "Minor", rootNote: 9 }
  } });
  assert.deepEqual(reply.result.structuredContent.scale.noteNames, ["A", "B", "C", "D", "E", "F", "G"]);
});

test("complete Live scale catalog is exposed as a read-only MCP tool", async () => {
  const service = { async call(name) {
    assert.equal(name, "list_live_scales");
    return { scales: listLiveScaleReferences() };
  } };
  const reply = await createRouter(service)({ id: 1, method: "tools/call", params: {
    name: "list_live_scales", arguments: {}
  } });
  assert.equal(reply.result.structuredContent.scales.length, 35);
  assert.equal(reply.result.structuredContent.scales.some(scale => scale.name === "Phrygian Dominant"), true);
});
