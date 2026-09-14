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
    await assert.rejects(() => analyzeAudioFile(sourcePath, { channelIndex: 2 }), /channelIndex/);
    await assert.rejects(() => analyzeAudioFile(sourcePath, { channelIndex: 0.5 }), /channelIndex/);
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

test("pitch analysis reports time-varying notes and unvoiced frames across the source window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cavi-pitch-trajectory-"));
  try {
    const sourcePath = join(directory, "notes.wav");
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "aevalsrc=if(lt(t\\,0.7)\\,0.5*sin(2*PI*440*t)\\,if(lt(t\\,1.3)\\,0\\,0.5*sin(2*PI*880*t))):s=48000:d=2", sourcePath]);
    const result = await analyzeAudioFile(sourcePath, { includePitch: true });
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
  assert.match(remote.error.message, /absolute local/);
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
