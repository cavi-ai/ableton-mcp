import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";

function gridService({ numerator = 4, denominator = 4, tempo = 120, contextVersion = 7,
  secondSignature = null } = {}) {
  const live = { stateVersion: 7, setFingerprint: "set:grid", tempo };
  const context = { stateVersion: contextVersion, timeSignature: { numerator, denominator },
    key: { rootNote: 0, rootName: "C", scaleName: "Major", scaleMode: true, scaleIntervals: [0, 2, 4, 5, 7, 9, 11] },
    quantization: { clipTrigger: { value: 4, name: "1_bar", choices: [] }, midiRecording: { value: 0, name: "none", choices: [] } },
    groove: { amount: 0, swingAmount: 0, pool: [] }, loop: { enabled: false, startBeats: 8, lengthBeats: 16 } };
  let contextReads = 0;
  return new ToolService({ bridge: { async request(method) {
    if (method === "get_live_state") return structuredClone(live);
    if (method === "get_song_musical_context") {
      contextReads++;
      return { ...structuredClone(context), timeSignature: contextReads > 1 && secondSignature ? secondSignature : structuredClone(context.timeSignature) };
    }
    throw new Error(`unexpected native method ${method}`);
  } } });
}

test("a 4/4 bar distinguishes its single downbeat from four beat starts across straight and triplet grids", async () => {
  const reply = await createRouter(gridService())({ id: 1, method: "tools/call", params: {
    name: "get_song_grid_reference", arguments: {} } });
  assert.equal(reply.error, undefined);
  const reference = reply.result.structuredContent;
  assert.deepEqual(reference.timeSignature, { numerator: 4, denominator: 4 });
  assert.equal(reference.tempoBpm, 120);
  assert.equal(reference.grids.straight16.stepsPerBar, 16);
  assert.deepEqual(reference.grids.straight16.barDownbeatSteps, [1]);
  assert.deepEqual(reference.grids.straight16.meterBeatSteps, [1, 5, 9, 13]);
  assert.deepEqual(reference.grids.straight16.eighthOffbeatSteps, [3, 7, 11, 15]);
  assert.equal(reference.grids.eighthTriplet.stepsPerBar, 12);
  assert.deepEqual(reference.grids.eighthTriplet.meterBeatSteps, [1, 4, 7, 10]);
  assert.equal(reference.grids.sixteenthTriplet.stepsPerBar, 24);
  assert.deepEqual(reference.grids.sixteenthTriplet.meterBeatSteps, [1, 7, 13, 19]);
});

test("4/4 groove examples anchor snare and kick roles to beats rather than one fixed step count", async () => {
  const reference = await gridService().call("get_song_grid_reference", {});
  assert.ok(reference.conventions);
  assert.deepEqual(reference.conventions.hipHopBackbeat, {
    snareBeats: [2, 4], straight16Steps: [5, 13], eighthTripletSteps: [4, 10], sixteenthTripletSteps: [7, 19] });
  assert.deepEqual(reference.conventions.houseFourOnFloor, { kickBeats: [1, 2, 3, 4], snareBeats: [2, 4] });
  assert.deepEqual(reference.conventions.trapHalfTime, {
    snareBeats: [3], straight16Steps: [9], eighthTripletSteps: [7], sixteenthTripletSteps: [13],
    hatSubdivisionExamples: ["eighthTriplet", "sixteenthTriplet"] });
  assert.equal(reference.conventions.bindingRule, "examples_not_rules");
});

test("a 120-to-60 breakdown distinguishes perceived half-time from changing Live project tempo", async () => {
  const reference = await gridService().call("get_song_grid_reference", {});
  assert.ok(reference.tempoInterpretation);
  assert.deepEqual(reference.tempoInterpretation, {
    projectTempoBpm: 120, perceivedHalfTimeBpm: 60, perceivedDoubleTimeBpm: 240,
    quarterSecondsAtProjectTempo: 0.5, barSecondsAtProjectTempo: 2,
    barSecondsIfProjectTempoHalved: 4, perceivedHalfTimeChangesProjectTempo: false,
    projectTempoChangeRequiresWarpAndMidiAudit: true });
});

test("a 3/8 bar reports when triplet grid cells cannot land on every meter beat or bar boundary", async () => {
  const reference = await gridService({ numerator: 3, denominator: 8 }).call("get_song_grid_reference", {});
  assert.equal(reference.conventions, null);
  assert.equal(reference.barLengthBeats, 1.5);
  const grid = reference.grids.eighthTriplet;
  assert.equal(grid.stepsPerBar, 4.5);
  assert.equal(grid.barBoundaryOnGrid, false);
  assert.deepEqual(reference.grids.straight16.eighthOffbeatSteps, []);
  assert.ok(Array.isArray(grid.meterBeatAnchors));
  assert.deepEqual(grid.meterBeatAnchors, [
    { meterBeat: 1, offsetBeats: 0, stepNumber: 1 },
    { meterBeat: 2, offsetBeats: 0.5, stepNumber: null },
    { meterBeat: 3, offsetBeats: 1, stepNumber: 4 }]);
});

test("a changed Live signature during reference lookup is rejected rather than returning stale steps", async () => {
  const service = gridService({ secondSignature: { numerator: 3, denominator: 4 } });
  await assert.rejects(() => service.call("get_song_grid_reference", {}), /song grid context changed/);
});

test("the grid reference points agents to existing straight and triplet quantization controls", async () => {
  const reference = await gridService().call("get_song_grid_reference", {});
  assert.ok(reference.toolReferences);
  assert.deepEqual(reference.toolReferences.midiQuantize, { tool: "transform_midi_notes", field: "operation.gridBeats",
    straight16: 0.25, eighthTriplet: 1 / 3, sixteenthTriplet: 1 / 6 });
  assert.deepEqual(reference.toolReferences.audioQuantize, { tool: "quantize_audio_clip", field: "grid",
    straight16: "1_16", eighthTriplet: "1_8_triplet", sixteenthTriplet: "1_16_triplet" });
  assert.equal(reference.toolReferences.grooveChoices, "get_song_musical_context");
  assert.equal(reference.toolReferences.grooveEdit, "set_groove");
  assert.equal(reference.toolReferences.transientGridInspection, "propose_audio_transient_warp");
  assert.equal(reference.toolReferences.actualTempoChange, "set_tempo");
  assert.equal(reference.toolReferences.clipLoopAndSignature, "get_clip_timing");
  assert.deepEqual(reference.toolReferences.clipGridEnvelope, { planner: "plan_grid_envelope_pattern",
    destination: "set_clip_parameter_envelope" });
});

test("the reference rejects an invalid native tempo rather than emitting infinite step durations", async () => {
  await assert.rejects(() => gridService({ tempo: 0 }).call("get_song_grid_reference", {}), /invalid Live tempo/);
});

test("the reference rejects an invalid native time signature rather than fabricating beat anchors", async () => {
  await assert.rejects(() => gridService({ numerator: 4, denominator: 0 }).call("get_song_grid_reference", {}),
    /invalid Live time signature/);
});

test("a straight 16th repeat pattern emits exact on and off steps for one 4/4 bar", async () => {
  const reply = await createRouter(gridService())({ id: 2, method: "tools/call", params: {
    name: "plan_grid_envelope_pattern", arguments: {
      grid: "straight16", bars: 1, activeSteps: [5, 13], onValue: 1, offValue: 0
    }
  } });
  assert.equal(reply.error, undefined);
  const result = reply.result.structuredContent;
  assert.equal(result.stateVersion, 7);
  assert.equal(result.points.length, 16);
  assert.deepEqual(result.points.slice(3, 6), [
    { time: 0.75, duration: 0.25, value: 0 },
    { time: 1, duration: 0.25, value: 1 },
    { time: 1.25, duration: 0.25, value: 0 }
  ]);
  assert.deepEqual(result.points[12], { time: 3, duration: 0.25, value: 1 });
  assert.deepEqual(result.points[15], { time: 3.75, duration: 0.25, value: 0 });
});

test("a triplet repeat pattern stays aligned across two bars and rejects nonintegral bar grids", async () => {
  const result = await gridService().call("plan_grid_envelope_pattern", {
    grid: "eighthTriplet", bars: 2, activeSteps: [4, 10], onValue: 1, offValue: 0
  });
  assert.equal(result.points.length, 24);
  assert.deepEqual(result.points[3], { time: 1, duration: 1 / 3, value: 1 });
  assert.deepEqual(result.points[15], { time: 5, duration: 1 / 3, value: 1 });
  await assert.rejects(() => gridService({ numerator: 3, denominator: 8 }).call("plan_grid_envelope_pattern", {
    grid: "eighthTriplet", bars: 2, activeSteps: [1], onValue: 1, offValue: 0
  }), /bar boundary/);
});

test("pattern planning rejects out-of-bar steps instead of placing them in another bar", async () => {
  await assert.rejects(() => gridService().call("plan_grid_envelope_pattern", {
    grid: "straight16", bars: 1, activeSteps: [17], onValue: 1, offValue: 0
  }), /activeSteps/);
});

test("pattern planning bounds output size and rejects beat offsets that cannot represent grid steps", async () => {
  await assert.rejects(() => gridService({ numerator: 99 }).call("plan_grid_envelope_pattern", {
    grid: "straight16", bars: 16, activeSteps: [1], onValue: 1, offValue: 0
  }), /too many envelope steps/);
  await assert.rejects(() => gridService().call("plan_grid_envelope_pattern", {
    grid: "straight16", bars: 1, activeSteps: [1], onValue: 1, offValue: 0,
    startBeat: Number.MAX_SAFE_INTEGER
  }), /startBeat/);
});
