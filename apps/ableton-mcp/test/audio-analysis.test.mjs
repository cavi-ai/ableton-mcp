import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAudioFile } from "../src/audio-analysis.mjs";
import { createRouter } from "../src/server.mjs";
import { ToolService } from "../src/tool-service.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("clip analysis rejects a bridge source belonging to another clip before opening it", async () => {
  const service = new ToolService({ bridge: { request: async (method, target) => {
    assert.equal(method, "get_audio_clip_state");
    assert.deepEqual(target, { trackId: "track-1", clipId: "track-1:clip-0" });
    return { stateVersion: 1, trackId: "track-0", clipId: "track-0:clip-0",
      source: { path: "/nonexistent-wrong-clip-source.wav" } };
  } } });
  await assert.rejects(() => service.call("analyze_audio_clip", { trackId: "track-1", clipId: "track-1:clip-0" }), /audio clip identity mismatch/);
});

test("MCP persistence analysis measures selected source channel without claiming resonance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-spectral-persistence-"));
  try {
    const sourcePath = join(directory, "stereo.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=0|0.5*sin(2*PI*1200*t):s=48000:d=1", sourcePath]);
    const route = createRouter(new ToolService({}));
    const reply = await route({ id: 1, method: "tools/call", params: { name: "analyze_audio_file",
      arguments: { sourcePath, includeResonanceCandidates: true, channelIndex: 1 } } });
    assert.equal(reply.error, undefined);
    const result = reply.result.structuredContent;
    assert.equal(result.spectrogram, undefined);
    assert.equal(result.resonanceCandidates.confirmedResonance, false);
    assert.equal(result.resonanceCandidates.channelIndex, 1);
    assert.ok(result.resonanceCandidates.candidates.some(x => Math.abs(x.frequencyHz - 1200) < 12 && x.observedFrameFraction === 1));
    const silent = await analyzeAudioFile(sourcePath, { includeResonanceCandidates: true });
    assert.deepEqual(silent.resonanceCandidates.candidates, []);
    await assert.rejects(analyzeAudioFile(sourcePath, { includeResonanceCandidates: true, durationSeconds: .2 }), /four/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pitch analysis selects the requested source channel and rejects absent channels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-channel-pitch-"));
  try {
    const sourcePath = join(directory, "stereo.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=0.5*sin(2*PI*220*t)|0.5*sin(2*PI*440*t):s=48000:d=1", sourcePath]);
    const left = await analyzeAudioFile(sourcePath, { includePitch: true });
    const right = await analyzeAudioFile(sourcePath, { includePitch: true, channelIndex: 1 });
    assert.ok(Math.abs(left.monophonicPitch.estimate.frequencyHz - 220) < 1);
    assert.ok(Math.abs(right.monophonicPitch.estimate.frequencyHz - 440) < 1);
    assert.equal(right.monophonicPitch.channelIndex, 1);
    const route = createRouter(new ToolService({}));
    const reply = await route({ id: 1, method: "tools/call", params: {
      name: "analyze_audio_file", arguments: { sourcePath, includePitch: true, channelIndex: 1 }
    } });
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.structuredContent.monophonicPitch.channelIndex, 1);
    assert.ok(Math.abs(reply.result.structuredContent.monophonicPitch.estimate.frequencyHz - 440) < 1);
    const tuning = await route({ id: 2, method: "tools/call", params: { name: "analyze_audio_file",
      arguments: { sourcePath, targetMidiNote: 69, channelIndex: 1 } } });
    assert.equal(tuning.error, undefined);
    assert.equal(tuning.result.structuredContent.tuningMeasurement.pitchCorrectionApplied, false);
    assert.equal(tuning.result.structuredContent.tuningMeasurement.channelIndex, 1);
    assert.ok(Math.abs(tuning.result.structuredContent.tuningMeasurement.medianCentsFromTarget) < 2);
    assert.equal(tuning.result.structuredContent.tuningMeasurement.measuredFrameFraction, 1);
    assert.equal(tuning.result.structuredContent.tuningMeasurement.wholeClipTuningProposal.eligible, true);
    assert.deepEqual(tuning.result.structuredContent.tuningMeasurement.wholeClipTuningProposal.pitchOffset, { coarse: 0, fine: 0 });
    let clipReads = 0;
    const clipRoute = createRouter(new ToolService({ bridge: { async request(method, target) {
      assert.equal(method, "get_audio_clip_state");
      assert.deepEqual(target, { trackId: "track-1", clipId: "track-1:clip-0" });
      clipReads++;
      return { stateVersion: 4, ...target, pitch: { coarse: 2, fine: 10 }, source: { path: sourcePath } };
    } } }));
    const clipAnalysis = await clipRoute({ id: 3, method: "tools/call", params: { name: "analyze_audio_clip",
      arguments: { trackId: "track-1", clipId: "track-1:clip-0", targetMidiNote: 69, includePitchEvents: true, includeResonanceCandidates: true, channelIndex: 1 } } });
    assert.equal(clipAnalysis.error, undefined);
    assert.equal(clipReads, 2);
    assert.equal(clipAnalysis.result.structuredContent.measurement.scope, "source_audio");
    assert.equal(clipAnalysis.result.structuredContent.measurement.tuningMeasurement.channelIndex, 1);
    assert.deepEqual(clipAnalysis.result.structuredContent.measurement.pitchEvents.events.map(event => event.noteName), ["A4"]);
    assert.ok(Math.abs(clipAnalysis.result.structuredContent.measurement.tuningMeasurement.medianCentsFromTarget) < 2);
    assert.equal(clipAnalysis.result.structuredContent.clipPitchAdjustment.eligible, true);
    assert.deepEqual(clipAnalysis.result.structuredContent.clipPitchAdjustment.currentPitch, { coarse: 2, fine: 10 });
    assert.deepEqual(clipAnalysis.result.structuredContent.clipPitchAdjustment.proposedPitch, { coarse: 0, fine: 0 });
    assert.equal(clipAnalysis.result.structuredContent.clipPitchAdjustment.changeCents, -210);
    assert.equal(clipAnalysis.result.structuredContent.measurement.resonanceCandidates.confirmedResonance, false);
    await assert.rejects(() => analyzeAudioFile(sourcePath, { channelIndex: 2 }), /channelIndex/);
    await assert.rejects(() => analyzeAudioFile(sourcePath, { channelIndex: 0.5 }), /channelIndex/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("guarded full-source tuning binds measured mono audio and verifies clip pitch readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-audio-tuning-"));
  try {
    const sourcePath = join(directory, "tone.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=0.5*sin(2*PI*445*t):s=48000:d=1", sourcePath]);
    const state = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0", location: "session", timeline: null,
      source: { path: sourcePath, lengthSamples: 48000 }, gain: { value: 0.5, min: 0, max: 1, displayValue: "0 dB" },
      pitch: { coarse: 0, fine: 0 }, warping: true, warpMode: { value: 0, name: "beats", choices: [] },
      warpMarkers: { supported: true, markers: [] }, markers: { unit: "beats", startBeats: 0, endBeats: 2 },
      loop: { enabled: false, unit: "beats", startBeats: 0, endBeats: 2 } };
    const service = new ToolService({ bridge: { async request(method, plan) {
      if (method === "get_audio_clip_state") return structuredClone(state);
      if (method === "set_audio_clip_state") {
        assert.deepEqual(plan.before.pitch, { coarse: 0, fine: 0 });
        state.pitch = { coarse: plan.changes.pitchCoarse.value, fine: plan.changes.pitchFine.value };
        state.stateVersion++;
        return structuredClone(state);
      }
      throw new Error(method);
    } } });
    const args = { trackId: state.trackId, clipId: state.clipId, expectedStateVersion: 4, targetMidiNote: 69 };
    const dry = await service.call("apply_monophonic_audio_tuning", args);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.plan.method, "set_audio_clip_state");
    assert.equal(dry.plan.measurement.channels.length, 1);
    assert.match(dry.plan.measurement.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(dry.plan.changes.pitchCoarse.value, 0);
    assert.ok(Math.abs(dry.plan.changes.pitchFine.value + 19) <= 3);
    const applied = await service.call("apply_monophonic_audio_tuning", { ...args, dryRun: false,
      confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash });
    assert.deepEqual(applied.observed.pitch, { coarse: dry.plan.changes.pitchCoarse.value,
      fine: dry.plan.changes.pitchFine.value });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("whole-source tuning refuses stereo channels with different fundamentals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-audio-tuning-stereo-"));
  try {
    const sourcePath = join(directory, "different-notes.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=0.5*sin(2*PI*440*t)|0.5*sin(2*PI*880*t):s=48000:d=1", sourcePath]);
    const clip = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0",
      source: { path: sourcePath }, pitch: { coarse: 0, fine: 0 } };
    const service = new ToolService({ bridge: { async request(method) {
      assert.equal(method, "get_audio_clip_state");
      return structuredClone(clip);
    } } });
    await assert.rejects(() => service.call("apply_monophonic_audio_tuning", {
      trackId: clip.trackId, clipId: clip.clipId, expectedStateVersion: 4, targetMidiNote: 69
    }), /channels disagree|stable monophonic/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("whole-source tuning refuses a source changed after confirmation planning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-audio-tuning-revision-"));
  try {
    const sourcePath = join(directory, "tone.wav");
    const render = async amplitude => promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
      `aevalsrc=${amplitude}*sin(2*PI*445*t):s=48000:d=1`, sourcePath]);
    await render(0.5);
    let writes = 0;
    const clip = { stateVersion: 4, trackId: "track-0", clipId: "track-0:clip-0",
      source: { path: sourcePath }, pitch: { coarse: 0, fine: 0 } };
    const service = new ToolService({ bridge: { async request(method) {
      if (method === "get_audio_clip_state") return structuredClone(clip);
      if (method === "set_audio_clip_state") { writes++; return structuredClone(clip); }
      throw new Error(method);
    } } });
    const args = { trackId: clip.trackId, clipId: clip.clipId, expectedStateVersion: 4, targetMidiNote: 69 };
    const dry = await service.call("apply_monophonic_audio_tuning", args);
    await render(0.25);
    await assert.rejects(() => service.call("apply_monophonic_audio_tuning", { ...args, dryRun: false,
      confirmationToken: dry.confirmation.token, planHash: dry.confirmation.planHash }), /confirmation|plan|hash/i);
    assert.equal(writes, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("waveform overview covers the complete source window with bounded extrema and RMS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-waveform-"));
  try {
    const sourcePath = join(directory, "levels.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(lt(t\\,0.5)\\,0.25\\,-0.5):s=48000:d=1", "-c:a", "pcm_f32le", sourcePath]);
    const result = await analyzeAudioFile(sourcePath, { includeWaveform: true });
    const route = createRouter(new ToolService({}));
    const reply = await route({ id: 1, method: "tools/call", params: {
      name: "analyze_audio_file", arguments: { sourcePath, includeWaveform: true }
    } });
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.result.structuredContent.waveform, result.waveform);
    const waveform = result.waveform;
    assert.equal(waveform.buckets.length, 1024);
    assert.equal(waveform.sampleCount, 48000);
    assert.equal(waveform.buckets[0].startSeconds, 0);
    assert.equal(waveform.buckets.at(-1).endSeconds, 1);
    assert.equal(waveform.buckets[0].min, 0.25);
    assert.equal(waveform.buckets[0].max, 0.25);
    assert.equal(waveform.buckets[0].rms, 0.25);
    assert.equal(waveform.buckets.at(-1).min, -0.5);
    assert.equal(waveform.buckets.at(-1).rms, 0.5);
    for (let i = 1; i < waveform.buckets.length; i++)
      assert.equal(waveform.buckets[i].startSeconds, waveform.buckets[i - 1].endSeconds);
    assert.equal((await analyzeAudioFile(sourcePath)).waveform, undefined);
    await assert.rejects(() => analyzeAudioFile(sourcePath, { includeWaveform: "yes" }), /includeWaveform/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("transient analysis reports timed source onsets through file and clip tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-transients-"));
  try {
    const sourcePath = join(directory, "pulses.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(between(t\\,0.2\\,0.22)\\,0.8\\,if(between(t\\,0.6\\,0.62)\\,0.8\\,0)):s=48000:d=1",
      "-c:a", "pcm_f32le", sourcePath]);
    const route = createRouter(new ToolService({}));
    const fileReply = await route({ id: 1, method: "tools/call", params: { name: "analyze_audio_file",
      arguments: { sourcePath, startSeconds: 0.1, durationSeconds: 0.8, includeTransients: true } } });
    assert.equal(fileReply.error, undefined);
    const transients = fileReply.result.structuredContent.transients;
    assert.equal(transients.scope, "source_audio");
    assert.equal(transients.channelIndex, 0);
    assert.equal(transients.candidates.length, 2);
    for (let index = 0; index < 2; index++) {
      assert.ok(Math.abs(transients.candidates[index].sourceSeconds - [0.2, 0.6][index]) <= 0.015);
      const candidate = transients.candidates[index];
      assert.ok(candidate.strength > 0 && candidate.strength <= 1);
    }
    const clipRoute = createRouter(new ToolService({ bridge: { async request(method, target) {
      assert.equal(method, "get_audio_clip_state");
      assert.deepEqual(target, { trackId: "track-2", clipId: "track-2:clip-0" });
      return { stateVersion: 4, ...target, source: { path: sourcePath } };
    } } }));
    const clipReply = await clipRoute({ id: 2, method: "tools/call", params: { name: "analyze_audio_clip",
      arguments: { trackId: "track-2", clipId: "track-2:clip-0", startSeconds: 0.1, durationSeconds: 0.8, includeTransients: true } } });
    assert.equal(clipReply.error, undefined);
    assert.deepEqual(clipReply.result.structuredContent.measurement.transients.candidates, transients.candidates);
    assert.equal((await analyzeAudioFile(sourcePath)).transients, undefined);
    await assert.rejects(() => analyzeAudioFile(sourcePath, { includeTransients: "yes" }), /includeTransients/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native source-time tool rejects a response for another audio clip", async () => {
  const service = new ToolService({ bridge: { async request(method, target) {
    assert.equal(method, "get_audio_source_beat_times");
    assert.deepEqual(target, { trackId: "track-2", clipId: "track-2:clip-0", sourceSeconds: [0.2] });
    return { stateVersion: 4, trackId: "track-3", clipId: "track-3:clip-0", sourcePath: "/tmp/pulse.wav",
      conversion: "native", points: [{ sourceSeconds: 0.2, beatTime: 0.4 }] };
  } } });
  await assert.rejects(() => service.call("get_audio_source_beat_times", {
    trackId: "track-2", clipId: "track-2:clip-0", sourceSeconds: [0.2] }), /audio clip identity mismatch/);
});

test("transient warp proposal uses native beats and returns reviewable source-preserving marker actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-warp-proposals-"));
  try {
    const sourcePath = join(directory, "pulses.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(between(t\\,0.2\\,0.22)\\,0.8\\,if(between(t\\,0.6\\,0.62)\\,0.8\\,0)):s=48000:d=1",
      "-c:a", "pcm_f32le", sourcePath]);
    const clipState = { stateVersion: 4, trackId: "track-2", clipId: "track-2:clip-0", location: "session",
      timeline: null, source: { path: sourcePath, lengthSamples: 48000 }, gain: { value: 0.4, min: 0, max: 1, displayValue: "0.00 dB" },
      pitch: { coarse: 0, fine: 0 }, warping: true, warpMode: { value: 0, name: "beats", choices: [] },
      warpMarkers: { supported: true, markers: [{ sampleTime: 0, beatTime: 0 }, { sampleTime: 0.015625, beatTime: 0.03125 }] },
      markers: { unit: "beats", startBeats: 0, endBeats: 2 }, loop: { enabled: false, unit: "beats", startBeats: 0, endBeats: 2 } };
    const service = new ToolService({ bridge: { async request(method, target) {
      if (method === "get_audio_clip_state") {
        assert.deepEqual(target, { trackId: "track-2", clipId: "track-2:clip-0" });
        return clipState;
      }
      if (method === "get_clip_timing") return { stateVersion: 4, ...target,
        timeSignature: { numerator: 4, denominator: 4 } };
      assert.equal(method, "get_audio_source_beat_times");
      assert.equal(target.trackId, "track-2");
      assert.equal(target.clipId, "track-2:clip-0");
      assert.ok([[0.2, 0.6], [0.19, 0.59]].some(times =>
        times.every((time, index) => time === target.sourceSeconds[index])));
      return { stateVersion: 4, trackId: "track-2", clipId: "track-2:clip-0", sourcePath,
        conversion: "native", points: target.sourceSeconds.map(sourceSeconds =>
          ({ sourceSeconds, beatTime: sourceSeconds * 2 })) };
    } } });
    const reply = await createRouter(service)({ id: 1, method: "tools/call", params: {
      name: "propose_audio_transient_warp", arguments: { trackId: "track-2", clipId: "track-2:clip-0",
        gridBeats: 0.5, startSeconds: 0.1, durationSeconds: 0.8, includeMusicalRoles: true, feelBars: 1 } } });
    assert.equal(reply.error, undefined);
    const proposal = reply.result.structuredContent;
    assert.equal(proposal.stateVersion, 4);
    assert.equal(proposal.nativeConversion, true);
    assert.deepEqual(proposal.meter, { numerator: 4, denominator: 4, barBeats: 4, slotsPerBar: 8 });
    assert.equal(proposal.feelSummary.format, "cavi-audio-feel-v1");
    assert.equal(proposal.feelSummary.nativeGrooveId, null);
    assert.deepEqual(proposal.feelSummary.slots.map(({ slot, hitCount, meanOffsetBeats }) =>
      ({ slot, hitCount, meanOffsetBeats })), [
      { slot: 1, hitCount: 1, meanOffsetBeats: -0.1 },
      { slot: 2, hitCount: 1, meanOffsetBeats: 0.2 }]);
    assert.deepEqual(proposal.feelSummary.source, {
      trackId: "track-2", clipId: "track-2:clip-0", stateVersion: 4, sourcePath });
    assert.deepEqual(proposal.gridAlignment.map(({ barIndex, slotInBar, barDownbeat, quarterPulse, halfBeatUpbeat }) =>
      ({ barIndex, slotInBar, barDownbeat, quarterPulse, halfBeatUpbeat })), [
      { barIndex: 0, slotInBar: 1, barDownbeat: false, quarterPulse: false, halfBeatUpbeat: true },
      { barIndex: 0, slotInBar: 2, barDownbeat: false, quarterPulse: true, halfBeatUpbeat: false }]);
    assert.ok(Array.isArray(proposal.gridAlignment));
    assert.deepEqual(proposal.gridAlignment.map(({ sourceSeconds, currentBeatTime, nearestGridBeatTime,
      signedOffsetBeats, inClipRegion }) => ({ sourceSeconds, currentBeatTime, nearestGridBeatTime,
      signedOffsetBeats, inClipRegion })), [
      { sourceSeconds: 0.2, currentBeatTime: 0.4, nearestGridBeatTime: 0.5, signedOffsetBeats: -0.1, inClipRegion: true },
      { sourceSeconds: 0.6, currentBeatTime: 1.2, nearestGridBeatTime: 1, signedOffsetBeats: 0.2, inClipRegion: true }]);
    assert.deepEqual(proposal.actions.map(({ sourceSeconds, currentBeatTime, targetBeatTime, method, sampleTime }) =>
      ({ sourceSeconds, currentBeatTime, targetBeatTime, method, sampleTime })), [
      { sourceSeconds: 0.2, currentBeatTime: 0.4, targetBeatTime: 0.5, method: "add_audio_warp_marker", sampleTime: 0.2 },
      { sourceSeconds: 0.6, currentBeatTime: 1.2, targetBeatTime: 1, method: "add_audio_warp_marker", sampleTime: 0.6 }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("transient warp proposal does not recommend moving a marker across its neighbor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-warp-neighbor-"));
  try {
    const sourcePath = join(directory, "pulse.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(between(t\\,0.2\\,0.22)\\,0.8\\,0):s=48000:d=1", "-c:a", "pcm_f32le", sourcePath]);
    const clipState = { stateVersion: 4, trackId: "track-2", clipId: "track-2:clip-0",
      source: { path: sourcePath }, warping: true,
      markers: { unit: "beats", startBeats: 0, endBeats: 2 },
      warpMarkers: { supported: true, markers: [
        { sampleTime: 0, beatTime: 0 }, { sampleTime: 0.2, beatTime: 0.6 },
        { sampleTime: 0.25, beatTime: 0.7 }, { sampleTime: 1, beatTime: 2 }
      ] } };
    const service = new ToolService({ bridge: { async request(method, target) {
      if (method === "get_audio_clip_state") return clipState;
      assert.equal(method, "get_audio_source_beat_times");
      assert.ok([0.2, 0.19].includes(target.sourceSeconds[0]));
      return { stateVersion: 4, trackId: "track-2", clipId: "track-2:clip-0", sourcePath,
        conversion: "native", points: [{ sourceSeconds: target.sourceSeconds[0], beatTime: target.sourceSeconds[0] * 3 }] };
    } } });
    const proposal = await service.call("propose_audio_transient_warp", {
      trackId: "track-2", clipId: "track-2:clip-0", gridBeats: 1 });
    assert.equal(proposal.gridAlignment[0].nearestGridBeatTime, 1);
    assert.deepEqual(proposal.actions, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("transient warp proposal leaves a slot alone when another onset is already on grid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-warp-collision-"));
  try {
    const sourcePath = join(directory, "pulses.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(between(t\\,0.45\\,0.47)\\,0.4\\,if(between(t\\,0.6\\,0.62)\\,0.8\\,0)):s=48000:d=1",
      "-c:a", "pcm_f32le", sourcePath]);
    const state = { stateVersion: 4, trackId: "track-2", clipId: "track-2:clip-0",
      source: { path: sourcePath }, warping: true,
      markers: { unit: "beats", startBeats: 0, endBeats: 2 },
      warpMarkers: { supported: true, markers: [{ sampleTime: 0, beatTime: 0 }, { sampleTime: 1, beatTime: 2 }] } };
    const service = new ToolService({ bridge: { async request(method, target) {
      if (method === "get_audio_clip_state") return state;
      assert.equal(method, "get_audio_source_beat_times");
      assert.ok([[0.45, 0.6], [0.44, 0.59]].some(times =>
        times.every((time, index) => time === target.sourceSeconds[index])));
      return { stateVersion: 4, trackId: state.trackId, clipId: state.clipId, sourcePath,
        conversion: "native", points: target.sourceSeconds.map(sourceSeconds =>
          ({ sourceSeconds, beatTime: sourceSeconds * 5 / 3 })) };
    } } });
    const proposal = await service.call("propose_audio_transient_warp", {
      trackId: state.trackId, clipId: state.clipId, gridBeats: 0.5 });
    assert.equal(proposal.gridAlignment.length, 2);
    assert.deepEqual(proposal.actions, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("transient warp proposal does not move an onset by only one detector hop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-warp-resolution-"));
  try {
    const sourcePath = join(directory, "pulse.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(between(t\\,0.61\\,0.63)\\,0.8\\,0):s=48000:d=1",
      "-c:a", "pcm_f32le", sourcePath]);
    const state = { stateVersion: 4, trackId: "track-2", clipId: "track-2:clip-0",
      source: { path: sourcePath }, warping: true,
      markers: { unit: "beats", startBeats: 0, endBeats: 2 },
      warpMarkers: { supported: true, markers: [{ sampleTime: 0, beatTime: 0 }, { sampleTime: 1, beatTime: 2 }] } };
    const service = new ToolService({ bridge: { async request(method, target) {
      if (method === "get_audio_clip_state") return state;
      assert.equal(method, "get_audio_source_beat_times");
      const beatTime = target.sourceSeconds[0] === 0.61 ? 1.0166666666666666
        : target.sourceSeconds[0] === 0.6 ? 1 : null;
      assert.notEqual(beatTime, null);
      return { stateVersion: 4, trackId: state.trackId, clipId: state.clipId, sourcePath,
        conversion: "native", points: [{ sourceSeconds: target.sourceSeconds[0], beatTime }] };
    } } });
    const proposal = await service.call("propose_audio_transient_warp", {
      trackId: state.trackId, clipId: state.clipId, gridBeats: 0.5 });
    assert.equal(proposal.gridAlignment.length, 1);
    assert.equal(proposal.gridAlignment[0].withinDetectorResolution, true);
    assert.deepEqual(proposal.actions, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pitch analysis reports time-varying notes and unvoiced frames across the source window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-pitch-trajectory-"));
  try {
    const sourcePath = join(directory, "notes.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(lt(t\\,0.7)\\,0.5*sin(2*PI*440*t)\\,if(lt(t\\,1.3)\\,0\\,0.5*sin(2*PI*880*t))):s=48000:d=2", sourcePath]);
    const result = await analyzeAudioFile(sourcePath, { includePitchEvents: true });
    const frames = result.monophonicPitch.frames;
    assert.ok(Array.isArray(frames));
    assert.ok(frames.length > 1 && frames.length <= 64);
    assert.equal(frames[0].startSeconds, 0);
    assert.ok(Math.abs(frames[0].estimate.frequencyHz - 440) < 1);
    assert.equal(frames.at(-1).estimate.pitchReference.noteName, "A5");
    assert.ok(Math.abs(frames.at(-1).estimate.pitchReference.centsFromNote) < 3);
    assert.ok(Math.abs(frames.at(-1).endSeconds - 2) < 0.001);
    assert.ok(frames.some(frame => frame.startSeconds > 0.7 && frame.endSeconds < 1.3 && frame.estimate === null));
    assert.ok(frames.every((frame, index) => index === 0 || frame.startSeconds > frames[index - 1].startSeconds));
    assert.ok(frames.every((frame, index) => index === 0 || frame.startSeconds - frames[index - 1].startSeconds <= 0.128001));
    assert.ok(frames[0].harmonicPeaks?.some(peak => peak.harmonicNumber === 1 && Math.abs(peak.estimatedFrequencyHz - 440) < 1));
    assert.ok(frames.at(-1).harmonicPeaks?.some(peak => peak.harmonicNumber === 1 && Math.abs(peak.estimatedFrequencyHz - 880) < 1));
    assert.deepEqual(result.pitchEvents.events.map(event => event.noteName), ["A4", "A5"]);
    assert.ok(result.pitchEvents.events[0].endSeconds < result.pitchEvents.events[1].startSeconds);
    const eventReply = await createRouter(new ToolService({}))({ id: 1, method: "tools/call", params: {
      name: "analyze_audio_file", arguments: { sourcePath, includePitchEvents: true }
    } });
    assert.equal(eventReply.error, undefined);
    assert.deepEqual(eventReply.result.structuredContent.pitchEvents.events.map(event => event.noteName), ["A4", "A5"]);
    assert.ok(frames.filter(frame => frame.estimate === null).every(frame => Array.isArray(frame.harmonicPeaks) && frame.harmonicPeaks.length === 0));
    const route = createRouter(new ToolService({}));
    const reply = await route({ id: 1, method: "tools/call", params: {
      name: "analyze_audio_file", arguments: { sourcePath, startSeconds: 1.5, durationSeconds: 0.5, includePitch: true }
    } });
    assert.equal(reply.error, undefined);
    const tailFrames = reply.result.structuredContent.monophonicPitch.frames;
    assert.equal(tailFrames.length, 3);
    assert.equal(tailFrames[0].startSeconds, 1.5);
    assert.equal(tailFrames.at(-1).endSeconds, 2);
    assert.ok(tailFrames.every(frame => frame.estimate.pitchReference.noteName === "A5"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pure sine pitch analysis does not label numerical residue as higher harmonics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-harmonic-noise-"));
  try {
    const sourcePath = join(directory, "sine.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1", sourcePath]);
    const result = await analyzeAudioFile(sourcePath, { durationSeconds: 1, includePitch: true });
    assert.ok(result.monophonicPitch.frames.every(frame => frame.harmonicPeaks.length === 1 && frame.harmonicPeaks[0].harmonicNumber === 1));
    assert.equal(result.monophonicPitch.harmonicDynamicRangeDb, 80);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pitch analysis distinguishes the fundamental from a louder second harmonic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-harmonics-"));
  try {
    const sourcePath = join(directory, "harmonics.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=0.2*sin(2*PI*220*t)+0.6*sin(2*PI*440*t):s=48000:d=1", sourcePath]);
    const result = await analyzeAudioFile(sourcePath, { includePitch: true });
    assert.ok(Math.abs(result.monophonicPitch.estimate.frequencyHz - 220) < 1);
    const harmonics = result.monophonicPitch.harmonicPeaks;
    assert.equal(harmonics[0].harmonicNumber, 2);
    assert.ok(Math.abs(harmonics[0].estimatedFrequencyHz - 440) < 1);
    assert.ok(harmonics.some(peak => peak.harmonicNumber === 1));
    assert.ok(harmonics.every(peak => Math.abs(peak.centsFromHarmonic) <= 50));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("spectrogram follows a source frequency change across time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-spectrogram-"));
  try {
    const sourcePath = join(directory, "changing.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(lt(t\\,0.5)\\,0.5*sin(2*PI*440*t)\\,0.5*sin(2*PI*880*t)):s=48000:d=1", sourcePath]);
    const route = createRouter(new ToolService({}));
    const reply = await route({ id: 1, method: "tools/call", params: {
      name: "analyze_audio_file", arguments: { sourcePath, includeSpectrogram: true }
    } });
    assert.equal(reply.error, undefined);
    const spectrogram = reply.result.structuredContent.spectrogram;
    assert.ok(spectrogram.frames.length > 2 && spectrogram.frames.length <= 64);
    const first = spectrogram.frames[0], last = spectrogram.frames.at(-1);
    assert.equal(first.startSeconds, 0);
    assert.ok(last.startSeconds > 0.8);
    for (const [frame, frequency] of [[first, 440], [last, 880]]) {
      assert.equal(frame.amplitudesDbfs.length, 2049);
      const peakBin = frame.amplitudesDbfs.indexOf(Math.max(...frame.amplitudesDbfs));
      assert.ok(Math.abs(peakBin * spectrogram.frequencyResolutionHz - frequency) < 12);
      assert.ok(frame.amplitudesDbfs.every(Number.isFinite));
    }
    await assert.rejects(() => analyzeAudioFile(sourcePath, { includeSpectrogram: true, durationSeconds: 0.01 }), /full.*frame/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("generated source audio supports pitch through the MCP router", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-pitch-"));
  const run = promisify(execFile);
  try {
    const sourcePath = join(directory, "tone.wav");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=1", sourcePath]);
    const route = createRouter(new ToolService({}));
    const reply = await route({ id: 1, method: "tools/call", params: {
      name: "analyze_audio_file", arguments: { sourcePath, includePitch: true, includeSpectrum: true }
    } });
    assert.equal(reply.error, undefined);
    const measurement = reply.result.structuredContent;
    assert.ok(Math.abs(measurement.monophonicPitch.estimate.frequencyHz - 440) < 1);
    assert.equal(measurement.monophonicPitch.estimate.pitchReference.noteName, "A4");
    assert.equal(measurement.sampleRate, 96000);
    assert.equal(measurement.spectrum.sampleRate, 96000);
    assert.equal(measurement.monophonicPitch.sampleRate, 16000);
    await assert.rejects(() => analyzeAudioFile(sourcePath, { includePitch: true, durationSeconds: 0.1 }), /0.256-second/);
    const silencePath = join(directory, "silence.wav");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "1", silencePath]);
    const silence = await analyzeAudioFile(silencePath, { includePitch: true });
    assert.equal(silence.monophonicPitch.estimate, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audio analysis rejects network sources and unbounded windows", async () => {
  await assert.rejects(() => analyzeAudioFile("https://example.com/audio.wav"), /absolute local/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { durationSeconds: 61 }), /durationSeconds/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { startSeconds: -1 }), /startSeconds/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { includeSpectrum: "yes" }), /includeSpectrum/);
  await assert.rejects(() => analyzeAudioFile("/missing.wav", { includePitch: "yes" }), /includePitch/);
});

test("MCP audio analysis validates bounded windows before running analysis", async () => {
  const route = createRouter(new ToolService({}));
  const listed = await route({ id: 1, method: "tools/list" });
  assert.ok(listed.result.tools.some(tool => tool.name === "analyze_audio_file"));
  for (const arguments_ of [
    { sourcePath: "/audio.wav", durationSeconds: 61 },
    { sourcePath: "/audio.wav", startSeconds: -1 },
    { sourcePath: "/audio.wav", durationSeconds: "10" },
    { sourcePath: "/audio.wav", includeSpectrum: "yes" },
    { sourcePath: "/audio.wav", includePitch: "yes" }
  ]) {
    const reply = await route({ id: 2, method: "tools/call", params: { name: "analyze_audio_file", arguments: arguments_ } });
    assert.equal(reply.error.code, -32602);
  }
  const remote = await route({ id: 3, method: "tools/call", params: { name: "analyze_audio_file", arguments: { sourcePath: "https://example.com/a.wav" } } });
  assert.equal(remote.error, undefined);
  assert.equal(remote.result.isError, true);
  assert.match(remote.result.content[0].text, /absolute local/);
});

test("clip analysis reports unavailable source rather than guessing a path", async () => {
  const service = new ToolService({ bridge: { async request(method, params) {
    assert.equal(method, "get_audio_clip_state");
    assert.deepEqual(params, { trackId: "track-0", clipId: "track-0:clip-0" });
    return { stateVersion: 1, ...params, source: { path: null, lengthSamples: -1 } };
  } } });
  await assert.rejects(() => service.call("analyze_audio_clip", {
    trackId: "track-0", clipId: "track-0:clip-0"
  }), /source file is unavailable/);
});
