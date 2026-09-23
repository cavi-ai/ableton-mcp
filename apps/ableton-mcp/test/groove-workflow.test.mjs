import test from "node:test";
import assert from "node:assert/strict";
import { inspectGroovePostconditions } from "../src/groove-workflow.mjs";
import { ToolService } from "../src/tool-service.mjs";

const snapshot = () => ({ stateVersion: 1, trackId: "track-1", clipId: "track-1:clip-0", trackName: "Bass", clipName: "Bass Clip",
  source: { type: "midi", content: { stateVersion: 1, trackId: "track-1", clipId: "track-1:clip-0", lengthBeats: 4, notes: [{ noteId: 1, pitch: 60, start: 0.25, duration: 0.1, velocity: 100, velocityDeviation: 0, releaseVelocity: 0, probability: 1, mute: false }] } },
  timing: { stateVersion: 1, trackId: "track-1", clipId: "track-1:clip-0", grooveId: "groove-0", loop: { startBeats: 0, endBeats: 4 } },
  musicalContext: { stateVersion: 1, groove: { amount: 1, pool: [{ id: "groove-0", name: "Swing" }] } } });

test("bake inspection observes removed assignment without inventing action provenance", () => {
  const before = snapshot(), after = snapshot();
  after.timing.grooveId = null;
  after.source.content.notes[0].start = 1 / 3;
  const result = inspectGroovePostconditions("bake", before, after);
  assert.equal(result.postconditionsObserved, true);
  assert.equal(result.sourceContentChanged, true);
  assert.equal(result.actionProvenanceVerified, false);
  after.musicalContext.groove.amount = 0.5;
  assert.throws(() => inspectGroovePostconditions("bake", before, after), /shared musical context/);
});

test("extraction inspection requires unchanged source and exactly one appended groove", () => {
  const before = snapshot(), after = snapshot();
  after.musicalContext.groove.pool.push({ id: "groove-1", name: "Extracted" });
  assert.equal(inspectGroovePostconditions("extract", before, after).addedGroove.id, "groove-1");
  after.source.content.notes[0].start = 0.5;
  assert.throws(() => inspectGroovePostconditions("extract", before, after), /source content/);
  after.clipName = "Other";
  assert.throws(() => inspectGroovePostconditions("extract", before, after), /identity/);
});

test("MCP groove inspection reads current native context and rejects mismatched targets", async () => {
  const before = snapshot(), after = snapshot();
  after.timing.grooveId = null;
  let reads = 0;
  const service = new ToolService({ bridge: { async request(method, args) {
    assert.equal(method, "get_clip_groove_context");
    assert.deepEqual(args, { trackId: before.trackId, clipId: before.clipId });
    reads++;
    return after;
  } } });
  const args = { trackId: before.trackId, clipId: before.clipId, operation: "bake", before };
  const result = await service.call("inspect_clip_groove_postconditions", args);
  assert.equal(result.postconditionsObserved, true);
  assert.equal(result.actionProvenanceVerified, false);
  assert.equal(reads, 1);
  await assert.rejects(service.call("inspect_clip_groove_postconditions", { ...args, clipId: "other" }), /target/);
});

test("groove inspection rejects malformed source, nested identity and unknown assignments", () => {
  const after = snapshot();
  after.timing.grooveId = null;
  for (const corrupt of [
    before => { before.source.content = {}; },
    before => { delete before.source.content.notes[0].noteId; },
    before => { delete before.source.content.notes[0].probability; },
    before => { before.source.type = "unknown"; },
    before => { before.source.content.clipId = "other"; },
    before => { before.timing.trackId = "other"; },
    before => { before.timing.grooveId = "not-a-groove"; },
    before => { before.musicalContext.groove.pool = {}; },
  ]) {
    const before = snapshot();
    corrupt(before);
    assert.throws(() => inspectGroovePostconditions("bake", before, after));
  }
});

test("audio bake inspection rejects stripped native audio state", () => {
  const before = snapshot(), after = snapshot();
  for (const item of [before, after]) item.source = { type: "audio", content: {
    trackId: item.trackId, clipId: item.clipId, source: { path: "/audio.wav", lengthSamples: 48000 },
    gain: { value: 0.4 }, pitch: { coarse: 0, fine: 0 }, warping: true,
    warpMode: { value: 0 }, warpMarkers: { markers: [] },
    markers: { unit: "beats", startBeats: 0, endBeats: 4 },
    loop: { enabled: true, unit: "beats", startBeats: 0, endBeats: 4 },
  } };
  after.timing.grooveId = null;
  assert.equal(inspectGroovePostconditions("bake", before, after).postconditionsObserved, true);
  for (const key of ["gain", "pitch", "warping", "warpMode", "warpMarkers", "markers", "loop"]) {
    const incomplete = structuredClone(before);
    delete incomplete.source.content[key];
    assert.throws(() => inspectGroovePostconditions("bake", incomplete, after));
  }
});
